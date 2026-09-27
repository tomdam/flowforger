import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KEYRING_WAITING_HINT, keyringTimeoutMessage, tokenCacheUnavailableMessage, waitForKeyring } from "../token-cache.js";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Simulates a Linux machine without libsecret: loading keytar (required eagerly
// by @azure/msal-node-extensions) throws the same dlopen error it does there.
// keytar can be reached through require() (the library's CJS build) or through
// import (its ESM build), so both loaders are patched.
const LIBSECRET_ERROR = "libsecret-1.so.0: cannot open shared object file: No such file or directory";
const CJS_PRELOAD = `
const Module = require('module');
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'keytar') throw new Error(${JSON.stringify(LIBSECRET_ERROR)});
  return orig.call(this, request, ...rest);
};
`;
const ESM_HOOKS = `
export async function resolve(specifier, context, next) {
  if (specifier === 'keytar') throw new Error(${JSON.stringify(LIBSECRET_ERROR)});
  return next(specifier, context);
}
`;

function runWithoutLibsecret(script: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ff-no-libsecret-"));
  const preload = join(dir, "no-libsecret.cjs");
  const hooks = join(dir, "no-libsecret-hooks.mjs");
  const register = join(dir, "register.mjs");
  writeFileSync(preload, CJS_PRELOAD);
  writeFileSync(hooks, ESM_HOOKS);
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
  return spawnSync(
    process.execPath,
    ["--require", preload, "--import", pathToFileURL(register).href, "--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: cliRoot,
      encoding: "utf8",
      // Never let a test touch the real ~/.flowforger token cache.
      env: { ...process.env, HOME: dir, USERPROFILE: dir, ...extraEnv },
    },
  );
}

describe("token cache is loaded lazily (Linux without libsecret)", () => {
  it("auth and init modules import without loading keytar", () => {
    const r = runWithoutLibsecret(`
      const auth = await import('./src/auth.ts');
      const init = await import('./src/init.ts');
      console.log(typeof auth.resolveRequiredScopes, typeof init.acquireInitToken);
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "function function");
  });

  it("using the cache fails with an actionable error instead of a crash", () => {
    const r = runWithoutLibsecret(`
      const { createCachePlugin } = await import('./src/token-cache.ts');
      try { await createCachePlugin(); console.log('NO ERROR'); }
      catch (e) { console.log(e.message); }
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /could not be loaded: libsecret-1\.so\.0/);
    assert.match(r.stdout, /--graph-token/);
  });
});

describe("FLOWFORGER_TOKEN_CACHE=file (headless Linux with a locked keyring)", () => {
  // Runs with keytar blocked, like a GitHub Ubuntu runner: file mode must not need libsecret,
  // because a machine without it is exactly where the file cache is wanted.
  it("stores and reloads the cache in a plaintext file, without loading keytar", () => {
    const r = runWithoutLibsecret(`
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
    const r = runWithoutLibsecret(`
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
});

describe("tokenCacheUnavailableMessage", () => {
  const err = new Error("libsecret-1.so.0: cannot open shared object file");

  it("gives Linux install commands when libsecret is missing", () => {
    const msg = tokenCacheUnavailableMessage(err, "linux");
    assert.match(msg, /apt-get install libsecret-1-0/);
    assert.match(msg, /dnf install libsecret/);
  });

  it("omits Linux install hints on other platforms", () => {
    const msg = tokenCacheUnavailableMessage(new Error("boom"), "win32");
    assert.doesNotMatch(msg, /apt-get/);
    assert.match(msg, /--sp-token/);
  });
});
