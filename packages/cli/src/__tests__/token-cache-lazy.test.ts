import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  KEYRING_WAITING_HINT,
  createEncryptedCachePlugin,
  decryptCache,
  encryptCache,
  keyringTimeoutMessage,
  loadOrCreateKey,
  tokenCacheUnavailableMessage,
  waitForKeyring,
} from "../token-cache.js";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The tests below run token-cache.ts in a child process with a temp HOME, so they never touch
// the real ~/.flowforger cache or the real OS credential store. `@napi-rs/keyring` is replaced
// there on both loaders (require for the CJS bundle, import for the ESM build): either it fails
// to load, as an unsupported platform or broken install would, or it is a fake credential store.
const LOAD_ERROR = "Cannot find native binding. npm has a bug related to optional dependencies";

const FAKE_KEYRING = `
const store = globalThis.__fakeKeyring ??= { entries: new Map(), calls: [] };
export class AsyncEntry {
  constructor(service, username, options) { this.id = service + '/' + username; store.calls.push(['new', this.id, options]); }
  async getPassword() { store.calls.push(['get', this.id]); return store.entries.get(this.id) ?? null; }
  async setPassword(v) { store.calls.push(['set', this.id]); store.entries.set(this.id, v); }
  async deletePassword() { store.calls.push(['delete', this.id]); return store.entries.delete(this.id); }
}
export default { AsyncEntry };
`;

function runWithKeyring(mode: "missing" | "fake", script: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ff-token-cache-"));
  const fake = join(dir, "fake-keyring.mjs");
  writeFileSync(fake, FAKE_KEYRING);
  const replace = mode === "missing"
    ? `throw new Error(${JSON.stringify(LOAD_ERROR)});`
    : `return { url: ${JSON.stringify(pathToFileURL(fake).href)}, shortCircuit: true };`;
  const preload = join(dir, "keyring-preload.cjs");
  writeFileSync(preload, `
const Module = require('module');
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@napi-rs/keyring') ${mode === "missing" ? `throw new Error(${JSON.stringify(LOAD_ERROR)})` : `throw new Error('use import')`};
  return orig.call(this, request, ...rest);
};
`);
  const hooks = join(dir, "keyring-hooks.mjs");
  writeFileSync(hooks, `
export async function resolve(specifier, context, next) {
  if (specifier === '@napi-rs/keyring') { ${replace} }
  return next(specifier, context);
}
`);
  const register = join(dir, "register.mjs");
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
  const r = spawnSync(
    process.execPath,
    ["--require", preload, "--import", pathToFileURL(register).href, "--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: cliRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir, FLOWFORGER_TOKEN_CACHE: "", ...extraEnv },
    },
  );
  return { ...r, home: dir };
}

describe("token cache is loaded lazily (keyring binding unavailable)", () => {
  it("auth and init modules import without loading the keyring binding", () => {
    const r = runWithKeyring("missing", `
      const auth = await import('./src/auth.ts');
      const init = await import('./src/init.ts');
      console.log(typeof auth.resolveRequiredScopes, typeof init.acquireInitToken);
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "function function");
  });

  it("using the cache fails with an actionable error instead of a crash", () => {
    const r = runWithKeyring("missing", `
      const { createCachePlugin } = await import('./src/token-cache.ts');
      try { await createCachePlugin(); console.log('NO ERROR'); }
      catch (e) { console.log(e.message); }
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /could not be loaded: Cannot find native binding/);
    assert.match(r.stdout, /FLOWFORGER_TOKEN_CACHE=file/);
    assert.match(r.stdout, /--graph-token/);
  });
});

describe("encrypted token cache (fake credential store)", () => {
  it("creates a key in the credential store, encrypts the cache file, and reads it back", () => {
    const r = runWithKeyring("fake", `
      const { createCachePlugin, CACHE_PATH } = await import('./src/token-cache.ts');
      const { readFileSync } = await import('node:fs');
      const logs = [];
      const plugin = await createCachePlugin((m) => logs.push(m));
      await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => '{"refresh":"secret-token"}' } });
      // A second plugin, as the next CLI run would create it, reuses the stored key.
      const again = await createCachePlugin();
      let loaded;
      await again.beforeCacheAccess({ tokenCache: { deserialize: (s) => { loaded = s; } } });
      const store = globalThis.__fakeKeyring;
      console.log(JSON.stringify({ logs, file: readFileSync(CACHE_PATH, 'utf8'), loaded, path: CACHE_PATH,
        keys: [...store.entries.keys()], options: store.calls.find((c) => c[0] === 'new')[2] }));
    `);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.deepEqual(out.logs, ["Auth: Using OS-level encrypted token cache"]);
    assert.ok(out.path.endsWith(join(".flowforger", "token-cache.encrypted.json")), out.path);
    assert.doesNotMatch(out.file, /secret-token/);
    assert.equal(JSON.parse(out.file).algorithm, "aes-256-gcm");
    assert.equal(out.loaded, '{"refresh":"secret-token"}');
    assert.deepEqual(out.keys, ["FlowForger/TokenCacheKey"]);
    // The kernel keyring is in memory only, so a silent fallback to it would lose the key on reboot.
    assert.deepEqual(out.options, { linux: { store: "secret-service" } });
  });

  it("deletes the cache of FlowForger 0.5.2 and earlier, which it cannot read", () => {
    const r = runWithKeyring("fake", `
      const { createCachePlugin, LEGACY_CACHE_PATH } = await import('./src/token-cache.ts');
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(LEGACY_CACHE_PATH), { recursive: true });
      writeFileSync(LEGACY_CACHE_PATH, 'dpapi-blob');
      writeFileSync(LEGACY_CACHE_PATH + '.lockfile', '');
      globalThis.__fakeKeyring = { entries: new Map([['FlowForger/TokenCache', '{"old":1}']]), calls: [] };
      const logs = [];
      await createCachePlugin((m) => logs.push(m));
      console.log(JSON.stringify({ logs, file: existsSync(LEGACY_CACHE_PATH), lock: existsSync(LEGACY_CACHE_PATH + '.lockfile'),
        keys: [...globalThis.__fakeKeyring.entries.keys()] }));
    `);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.file, false);
    assert.equal(out.lock, false);
    assert.deepEqual(out.keys, ["FlowForger/TokenCacheKey"]);
    assert.ok(out.logs.some((l: string) => /older FlowForger version; sign in once more/.test(l)), out.logs.join("\n"));
  });
});

describe("encryptCache / decryptCache", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh IV each time", () => {
    const a = encryptCache(key, "hello");
    const b = encryptCache(key, "hello");
    assert.notEqual(JSON.parse(a).iv, JSON.parse(b).iv);
    assert.equal(decryptCache(key, a), "hello");
    assert.equal(decryptCache(key, b), "hello");
  });

  it("refuses a wrong key and an altered file", () => {
    const file = encryptCache(key, "hello");
    assert.throws(() => decryptCache(randomBytes(32), file));
    const envelope = JSON.parse(file);
    const data = Buffer.from(envelope.data, "base64");
    data[0] ^= 1;
    assert.throws(() => decryptCache(key, JSON.stringify({ ...envelope, data: data.toString("base64") })));
  });

  it("refuses an unknown format version", () => {
    const envelope = { ...JSON.parse(encryptCache(key, "x")), version: 2 };
    assert.throws(() => decryptCache(key, JSON.stringify(envelope)), /unsupported token cache format/);
  });
});

describe("createEncryptedCachePlugin", () => {
  it("treats a cache it cannot decrypt as empty, says so once, and overwrites it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ff-enc-cache-")), "cache.json");
    writeFileSync(path, encryptCache(randomBytes(32), "old"));
    const logs: string[] = [];
    const key = randomBytes(32);
    const plugin = createEncryptedCachePlugin(path, key, (m) => logs.push(m));
    let loaded: string | undefined;
    const ctx = { tokenCache: { deserialize: (s: string) => { loaded = s; } } } as never;
    await plugin.beforeCacheAccess(ctx);
    await plugin.beforeCacheAccess(ctx);
    assert.equal(loaded, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /could not be decrypted/);
    await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => "new" } } as never);
    assert.equal(decryptCache(key, readFileSync(path, "utf8")), "new");
  });

  it("does not write the file when the cache did not change", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ff-enc-cache-")), "cache.json");
    const plugin = createEncryptedCachePlugin(path, randomBytes(32));
    await plugin.afterCacheAccess({ cacheHasChanged: false, tokenCache: { serialize: () => "x" } } as never);
    assert.throws(() => readFileSync(path));
  });
});

describe("loadOrCreateKey", () => {
  function fakeEntry(initial: string | null) {
    let value = initial;
    let sets = 0;
    return {
      entry: {
        getPassword: async () => value,
        setPassword: async (v: string) => { sets++; value = v; },
      },
      sets: () => sets,
    };
  }

  it("reuses a stored key", async () => {
    const stored = randomBytes(32);
    const f = fakeEntry(stored.toString("base64"));
    assert.deepEqual(await loadOrCreateKey(f.entry), stored);
    assert.equal(f.sets(), 0);
  });

  it("creates and stores a key when none, or a malformed one, is stored", async () => {
    for (const initial of [null, "", Buffer.from("short").toString("base64")]) {
      const f = fakeEntry(initial);
      const key = await loadOrCreateKey(f.entry);
      assert.equal(key.length, 32);
      assert.equal(f.sets(), 1);
      assert.deepEqual(await loadOrCreateKey(f.entry), key);
    }
  });

  it("uses the key that was kept when another process stored one at the same moment", async () => {
    const theirs = randomBytes(32);
    let reads = 0;
    const entry = {
      getPassword: async () => (reads++ === 0 ? null : theirs.toString("base64")),
      setPassword: async () => {},
    };
    assert.deepEqual(await loadOrCreateKey(entry), theirs);
  });
});

describe("FLOWFORGER_TOKEN_CACHE=file (headless Linux with no Secret Service)", () => {
  // Runs with the keyring binding unavailable: file mode must not need it, because a machine
  // without a usable credential store is exactly where the file cache is wanted.
  it("stores and reloads the cache in a plaintext file, without loading the keyring binding", () => {
    const r = runWithKeyring("missing", `
      const { createCachePlugin, PLAINTEXT_CACHE_PATH } = await import('./src/token-cache.ts');
      const { readFileSync, statSync } = await import('node:fs');
      const logs = [];
      const plugin = await createCachePlugin((m) => logs.push(m));
      await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: { serialize: () => '{"saved":1}' } });
      let loaded;
      await plugin.beforeCacheAccess({ tokenCache: { deserialize: (s) => { loaded = s; } } });
      const mode = process.platform === 'win32' ? 'n/a' : (statSync(PLAINTEXT_CACHE_PATH).mode & 0o777).toString(8);
      console.log(JSON.stringify({ logs, file: readFileSync(PLAINTEXT_CACHE_PATH, 'utf8'), loaded, mode, path: PLAINTEXT_CACHE_PATH }));
    `, { FLOWFORGER_TOKEN_CACHE: "file" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.match(out.logs[0], /^Auth: Using plaintext token cache /);
    assert.ok(out.path.endsWith(join(".flowforger", "token-cache.plaintext.json")), out.path);
    assert.equal(out.file, '{"saved":1}');
    assert.equal(out.loaded, '{"saved":1}');
    if (out.mode !== "n/a") assert.equal(out.mode, "600");
  });

  it("does not write the file when the cache did not change", () => {
    const r = runWithKeyring("missing", `
      const { createCachePlugin, PLAINTEXT_CACHE_PATH } = await import('./src/token-cache.ts');
      const { existsSync } = await import('node:fs');
      const plugin = await createCachePlugin();
      await plugin.afterCacheAccess({ cacheHasChanged: false, tokenCache: { serialize: () => 'x' } });
      console.log(existsSync(PLAINTEXT_CACHE_PATH));
    `, { FLOWFORGER_TOKEN_CACHE: "file" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "false");
  });

  it("is what the keyring-timeout error tells you to set", () => {
    const msg = keyringTimeoutMessage();
    assert.match(msg, /did not respond within 120s/);
    assert.match(msg, /unlock prompt was not answered/);
    assert.match(msg, /export FLOWFORGER_TOKEN_CACHE=file/);
    assert.match(msg, /--sp-token/);
  });
});

// A locked keyring waits on an unlock dialog (desktop Linux, WSL shows it on Windows), so the
// wait must allow typing a password, with a hint so the dialog gets noticed.
describe("waitForKeyring", () => {
  const sleep = (ms: number, value?: unknown) => new Promise((r) => setTimeout(() => r(value), ms));
  const opts = { hintAfterMs: 20, timeoutMs: 80 };

  it("passes a quick answer through without a hint", async () => {
    const hints: string[] = [];
    assert.equal(await waitForKeyring(sleep(1, "ok"), (m) => hints.push(m), opts), "ok");
    await sleep(40); // past the hint time: the timer must have been cleared
    assert.deepEqual(hints, []);
  });

  it("hints once while waiting on an unlock prompt, then passes the answer through", async () => {
    const hints: string[] = [];
    assert.equal(await waitForKeyring(sleep(50, "ok"), (m) => hints.push(m), opts), "ok");
    assert.deepEqual(hints, [KEYRING_WAITING_HINT]);
  });

  it("fails with the actionable message when the keyring never answers", async () => {
    await assert.rejects(waitForKeyring(new Promise(() => {}), () => {}, opts), /did not respond within 0\.08s[\s\S]*FLOWFORGER_TOKEN_CACHE=file/);
  });

  it("aborts the keyring call on the timeout", async () => {
    let signal: AbortSignal | undefined;
    await assert.rejects(waitForKeyring((s) => { signal = s; return new Promise(() => {}); }, () => {}, opts));
    assert.equal(signal?.aborted, true);
  });
});

describe("tokenCacheUnavailableMessage", () => {
  const err = new Error("Platform secure storage failure: DBus error");

  it("explains the Secret Service on Linux", () => {
    const msg = tokenCacheUnavailableMessage(err, "linux");
    assert.match(msg, /Secret Service/);
    assert.match(msg, /GNOME Keyring, KWallet or KeePassXC/);
    assert.match(msg, /FLOWFORGER_TOKEN_CACHE=file/);
  });

  it("omits the Linux hint on other platforms", () => {
    const msg = tokenCacheUnavailableMessage(new Error("boom"), "win32");
    assert.doesNotMatch(msg, /Secret Service/);
    assert.match(msg, /--sp-token/);
  });
});
