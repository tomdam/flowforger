/**
 * Persistent MSAL token cache shared by `--auth` (auth.ts) and `init` (init.ts).
 *
 * `@azure/msal-node-extensions` is loaded lazily, on first use, and must stay
 * that way: its entry point eagerly requires `keytar`, whose native binding
 * needs libsecret on Linux. A static import put that require at CLI startup,
 * so every command — even `--version` — crashed on Linux machines without
 * libsecret (slim containers, GitHub-hosted runners, many servers). Now only
 * commands that actually use the token cache need it, and they get an
 * actionable error instead of a dlopen stack trace.
 */

import type { ICachePlugin } from '@azure/msal-node';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CACHE_DIR = join(homedir(), '.flowforger');
export const CACHE_PATH = join(CACHE_DIR, 'token-cache.json');
/** Opt-in unencrypted cache (FLOWFORGER_TOKEN_CACHE=file), kept apart from the encrypted one. */
export const PLAINTEXT_CACHE_PATH = join(CACHE_DIR, 'token-cache.plaintext.json');

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
 * - Default: OS-level encrypted — Windows DPAPI (CurrentUser), macOS Keychain, Linux libsecret.
 * - FLOWFORGER_TOKEN_CACHE=file: a plain JSON file readable only by you (0600), for headless
 *   Linux where no unlocked keyring exists. Opt-in because the refresh token is then
 *   unencrypted on disk.
 *
 * `log` gets progress lines (callers may hold them back); `notify` gets the keyring hint,
 * which needs the user's attention now.
 */
export async function createCachePlugin(
  log: (msg: string) => void = () => {},
  notify: (msg: string) => void = log
): Promise<ICachePlugin> {
  // Checked before loading msal-node-extensions: that library requires keytar (libsecret)
  // eagerly, and a machine without libsecret is exactly where the file cache is needed.
  if (process.env.FLOWFORGER_TOKEN_CACHE === 'file') {
    mkdirSync(CACHE_DIR, { recursive: true });
    log(`Auth: Using plaintext token cache ${PLAINTEXT_CACHE_PATH} (FLOWFORGER_TOKEN_CACHE=file)`);
    return createPlaintextCachePlugin(PLAINTEXT_CACHE_PATH);
  }

  let ext: typeof import('@azure/msal-node-extensions');
  try {
    ext = await import('@azure/msal-node-extensions');
  } catch (err) {
    throw new Error(tokenCacheUnavailableMessage(err));
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const creating = ext.PersistenceCreator.createPersistence({
    cachePath: CACHE_PATH,
    dataProtectionScope: ext.DataProtectionScope.CurrentUser,
    serviceName: 'FlowForger',
    accountName: 'TokenCache',
  });
  // Only Linux: the macOS Keychain shows its own unlock dialog and never hangs headless, and
  // DPAPI never blocks.
  const persistence =
    process.platform === 'linux'
      ? await waitForKeyring(creating, notify)
      : await creating;

  log('Auth: Using OS-level encrypted token cache');
  return new ext.PersistenceCachePlugin(persistence);
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

/**
 * Wait for a keyring call: print `KEYRING_WAITING_HINT` if it takes longer than `hintAfterMs`,
 * and fail with `keyringTimeoutMessage()` after `timeoutMs`.
 */
export function waitForKeyring<T>(
  promise: Promise<T>,
  notify: (msg: string) => void,
  { hintAfterMs = KEYRING_HINT_AFTER_MS, timeoutMs = KEYRING_TIMEOUT_MS } = {}
): Promise<T> {
  let hint: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    hint = setTimeout(() => notify(KEYRING_WAITING_HINT), hintAfterMs);
    timer = setTimeout(() => reject(new Error(keyringTimeoutMessage(timeoutMs))), timeoutMs);
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
  if (platform === 'linux' && /libsecret/i.test(detail)) {
    lines.push(
      'On Linux it needs libsecret. Install it and retry:',
      '  Debian/Ubuntu:  sudo apt-get install libsecret-1-0',
      '  Fedora/RHEL:    sudo dnf install libsecret',
      '  Alpine:         apk add libsecret',
    );
  }
  lines.push(
    'Or keep the token cache in an unencrypted file readable only by you: export FLOWFORGER_TOKEN_CACHE=file',
    'Alternatively, skip --auth and pass tokens explicitly (--graph-token, --sp-token, --dv-token).',
  );
  return lines.join('\n');
}
