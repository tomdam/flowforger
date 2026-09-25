import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokenCacheUnavailableMessage } from "../token-cache.js";

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

function runWithoutLibsecret(script: string) {
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
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
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
