/**
 * Persistent MSAL token cache shared by `--auth` (auth.ts) and `init` (init.ts).
 *
 * The cache is a file encrypted with AES-256-GCM. Its key is 32 random bytes kept in the OS
 * credential store through `@napi-rs/keyring`: Windows Credential Manager, the macOS Keychain,
 * or the Secret Service on Linux (GNOME Keyring, KWallet, KeePassXC). Only the key goes to the
 * credential store, because Windows Credential Manager holds at most 2,560 bytes per entry and
 * a token cache is larger than that.
 *
 * This replaced `@azure/msal-node-extensions`, which depends on the archived `keytar` and so
 * made `npm install -g flowforger` print a deprecation warning for `prebuild-install`.
 * `@napi-rs/keyring` ships its binaries as per-platform optional packages, with no install
 * script. Caches written by the old library (`token-cache.json`) cannot be read without it, so
 * they are deleted and the user signs in once more.
 *
 * `@napi-rs/keyring` is loaded lazily, on first use, and must stay that way: a native binding
 * that fails to load (an unsupported platform, a broken install) must not break commands that
 * never touch the token cache, `--version` included.
 */

import type { ICachePlugin } from '@azure/msal-node';
import type { AsyncEntry } from '@napi-rs/keyring';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CACHE_DIR = join(homedir(), '.flowforger');
/** The encrypted cache. Its key lives in the OS credential store (`KEYRING_SERVICE`/`KEYRING_ACCOUNT`). */
export const CACHE_PATH = join(CACHE_DIR, 'token-cache.encrypted.json');
/** Opt-in unencrypted cache (FLOWFORGER_TOKEN_CACHE=file), kept apart from the encrypted one. */
export const PLAINTEXT_CACHE_PATH = join(CACHE_DIR, 'token-cache.plaintext.json');
/** Where `@azure/msal-node-extensions` kept the cache (FlowForger 0.5.2 and earlier). */
export const LEGACY_CACHE_PATH = join(CACHE_DIR, 'token-cache.json');

export const KEYRING_SERVICE = 'FlowForger';
export const KEYRING_ACCOUNT = 'TokenCacheKey';
/** The entry `@azure/msal-node-extensions` stored the whole cache in on macOS and Linux. */
const LEGACY_KEYRING_ACCOUNT = 'TokenCache';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';
/** Bound into the authentication tag, so a file encrypted for another purpose never decrypts as a cache. */
const AAD = Buffer.from('flowforger-token-cache-v1');

/**
 * Waiting for the Linux keyring. A locked keyring asks for its password in an unlock dialog
 * (desktop Linux, and WSL, which shows it on the Windows desktop), and the call waits for it —
 * so the wait must be long enough to type a password, with a hint after a few seconds so the
 * dialog is noticed. With no session to show the dialog (SSH, CI, WSL without a GUI) it never
 * answers: nothing else keeps Node alive, and the CLI used to exit silently with status 0.
 */
export const KEYRING_HINT_AFTER_MS = 3_000;
export const KEYRING_TIMEOUT_MS = 120_000;

/**
 * Create the token cache plugin.
 * - Default: an AES-256-GCM encrypted file whose key is in the OS credential store.
 * - FLOWFORGER_TOKEN_CACHE=file: a plain JSON file readable only by you (0600), for headless
 *   Linux where no Secret Service is running. Opt-in because the refresh token is then
 *   unencrypted on disk.
 *
 * `log` gets progress lines (callers may hold them back); `notify` gets the keyring hint,
 * which needs the user's attention now.
 */
export async function createCachePlugin(
  log: (msg: string) => void = () => {},
  notify: (msg: string) => void = log
): Promise<ICachePlugin> {
  // Checked before loading the keyring binding, so file mode works wherever that binding
  // cannot load or no credential store exists.
  if (process.env.FLOWFORGER_TOKEN_CACHE === 'file') {
    mkdirSync(CACHE_DIR, { recursive: true });
    log(`Auth: Using plaintext token cache ${PLAINTEXT_CACHE_PATH} (FLOWFORGER_TOKEN_CACHE=file)`);
    return createPlaintextCachePlugin(PLAINTEXT_CACHE_PATH);
  }

  // On Linux the binding falls back to the kernel keyring when no Secret Service runs. That
  // keyring is in memory only, so the key — and with it the cache — would be lost on every
  // reboot. Requiring the Secret Service fails instead, with the file-cache hint.
  const options = { linux: { store: 'secret-service' as const } };
  let keyring: typeof import('@napi-rs/keyring');
  let key: Buffer;
  try {
    keyring = await import('@napi-rs/keyring');
    const keyEntry = new keyring.AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT, options);
    // Only Linux: the macOS Keychain shows its own unlock dialog and never hangs headless, and
    // Windows Credential Manager never blocks.
    key =
      process.platform === 'linux'
        ? await waitForKeyring((signal) => loadOrCreateKey(keyEntry, signal), notify)
        : await loadOrCreateKey(keyEntry);
  } catch (err) {
    if (err instanceof KeyringTimeoutError) throw err;
    throw new Error(tokenCacheUnavailableMessage(err));
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    await removeLegacyCache(() => new keyring.AsyncEntry(KEYRING_SERVICE, LEGACY_KEYRING_ACCOUNT, options), log);
  } catch {
    // Cleanup only; the new cache works either way.
  }
  log('Auth: Using OS-level encrypted token cache');
  return createEncryptedCachePlugin(CACHE_PATH, key, log);
}

/** The parts of `AsyncEntry` the key store needs (a fake in tests). */
export type KeyEntry = Pick<AsyncEntry, 'getPassword' | 'setPassword'>;

/**
 * The cache key from the credential store, created on first use. After creating one it is read
 * back, so when two processes create a key at the same moment both use the one that was kept.
 */
export async function loadOrCreateKey(entry: KeyEntry, signal?: AbortSignal): Promise<Buffer> {
  const stored = decodeKey(await entry.getPassword(signal));
  if (stored) return stored;
  const created = randomBytes(KEY_BYTES);
  await entry.setPassword(created.toString('base64'), signal);
  return decodeKey(await entry.getPassword(signal)) ?? created;
}

function decodeKey(value: string | null | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, 'base64');
  return key.length === KEY_BYTES ? key : undefined;
}

/** Encrypt the serialized MSAL cache into the file's JSON envelope. */
export function encryptCache(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

/** Decrypt a file written by `encryptCache`. Throws when the key is wrong or the file was altered. */
export function decryptCache(key: Buffer, fileText: string): string {
  const envelope = JSON.parse(fileText) as { version?: unknown; algorithm?: unknown; iv: string; tag: string; data: string };
  if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM) {
    throw new Error(`unsupported token cache format (version ${String(envelope.version)})`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The encrypted file cache. A file that does not decrypt (its key was replaced, or it was
 * altered) is treated as empty and overwritten on the next sign-in.
 */
export function createEncryptedCachePlugin(path: string, key: Buffer, log: (msg: string) => void = () => {}): ICachePlugin {
  let reportedUnreadable = false;
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (!existsSync(path)) return;
      let text: string;
      try {
        text = decryptCache(key, readFileSync(path, 'utf-8'));
      } catch (err) {
        if (!reportedUnreadable) {
          reportedUnreadable = true;
          log(`Auth: The token cache could not be decrypted (${err instanceof Error ? err.message : String(err)}); signing in again replaces it`);
        }
        return;
      }
      cacheContext.tokenCache.deserialize(text);
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        writePrivateFile(path, encryptCache(key, cacheContext.tokenCache.serialize()));
      }
    },
  };
}

/**
 * Write a file readable only by the current user, through a temporary file and a rename so a
 * crash or a concurrent reader never sees half a file. Falls back to writing in place when the
 * rename is refused (Windows, while another process has the file open).
 */
function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    writeFileSync(path, content, { mode: 0o600 });
  }
  chmodSync(path, 0o600); // `mode` only applies when the file is created
}

/**
 * Delete the cache `@azure/msal-node-extensions` wrote (FlowForger 0.5.2 and earlier), which
 * this version cannot read: the file, its lock file, and on macOS the Keychain entry that held
 * the cache itself. Best effort; runs once, because the file is gone afterwards.
 */
async function removeLegacyCache(legacyEntry: () => Pick<AsyncEntry, 'deletePassword'>, log: (msg: string) => void): Promise<void> {
  if (!existsSync(LEGACY_CACHE_PATH)) return;
  rmSync(LEGACY_CACHE_PATH, { force: true });
  rmSync(`${LEGACY_CACHE_PATH}.lockfile`, { force: true });
  try {
    await legacyEntry().deletePassword();
  } catch {
    // Not there, or written with attributes this binding does not match (keytar on Linux).
  }
  log('Auth: Removed the token cache of an older FlowForger version; sign in once more');
}

/** Plain JSON file cache, readable only by the current user (the file is created 0600). */
function createPlaintextCachePlugin(path: string): ICachePlugin {
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (existsSync(path)) cacheContext.tokenCache.deserialize(readFileSync(path, 'utf-8'));
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        writeFileSync(path, cacheContext.tokenCache.serialize(), { mode: 0o600 });
        chmodSync(path, 0o600); // `mode` only applies when the file is created
      }
    },
  };
}

export const KEYRING_WAITING_HINT =
  'Auth: Waiting for the system keyring. If an unlock prompt opened, enter your keyring password there.';

class KeyringTimeoutError extends Error {}

/**
 * Wait for a keyring call: print `KEYRING_WAITING_HINT` if it takes longer than `hintAfterMs`,
 * and fail with `keyringTimeoutMessage()` after `timeoutMs`. A call given as a function gets an
 * AbortSignal that fires on the timeout.
 */
export function waitForKeyring<T>(
  call: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  notify: (msg: string) => void,
  { hintAfterMs = KEYRING_HINT_AFTER_MS, timeoutMs = KEYRING_TIMEOUT_MS } = {}
): Promise<T> {
  const controller = new AbortController();
  const promise = typeof call === 'function' ? call(controller.signal) : call;
  let hint: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    hint = setTimeout(() => notify(KEYRING_WAITING_HINT), hintAfterMs);
    timer = setTimeout(() => {
      controller.abort();
      reject(new KeyringTimeoutError(keyringTimeoutMessage(timeoutMs)));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(hint);
    clearTimeout(timer);
  });
}

export function keyringTimeoutMessage(timeoutMs: number = KEYRING_TIMEOUT_MS): string {
  return [
    `The system keyring did not respond within ${timeoutMs / 1000}s, so the encrypted token cache used by --auth is unavailable.`,
    'Either its unlock prompt was not answered, or the keyring is locked with no desktop session to unlock it (SSH, CI, WSL without a GUI).',
    'Run again and answer the prompt, or use an unencrypted cache file readable only by you:',
    '  export FLOWFORGER_TOKEN_CACHE=file',
    'Alternatively, skip --auth and pass tokens explicitly (--graph-token, --sp-token, --dv-token).',
  ].join('\n');
}

export function tokenCacheUnavailableMessage(err: unknown, platform: NodeJS.Platform = process.platform): string {
  const detail = err instanceof Error ? err.message : String(err);
  const lines = [`The encrypted token cache used by --auth could not be loaded: ${detail}`];
  if (platform === 'linux') {
    lines.push(
      'On Linux its key is kept by the Secret Service, so a keyring daemon must be running on the',
      'session D-Bus: GNOME Keyring, KWallet or KeePassXC. Servers, containers and CI usually have none.',
    );
  }
  lines.push(
    'Or keep the token cache in an unencrypted file readable only by you: export FLOWFORGER_TOKEN_CACHE=file',
    'Alternatively, skip --auth and pass tokens explicitly (--graph-token, --sp-token, --dv-token).',
  );
  return lines.join('\n');
}
