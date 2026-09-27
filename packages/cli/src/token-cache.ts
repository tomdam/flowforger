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
import { chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CACHE_DIR = join(homedir(), '.flowforger');
export const CACHE_PATH = join(CACHE_DIR, 'token-cache.json');
/** Opt-in unencrypted cache (FLOWFORGER_TOKEN_CACHE=file), kept apart from the encrypted one. */
export const PLAINTEXT_CACHE_PATH = join(CACHE_DIR, 'token-cache.plaintext.json');

/**
 * How long to wait for the Linux keyring. A secret service that is running but locked, with
 * no session to show an unlock prompt (WSL, SSH, CI), never answers: the call hangs, nothing
 * else keeps Node alive, and the CLI used to exit silently with status 0 mid-login.
 */
export const KEYRING_TIMEOUT_MS = 15_000;

/**
 * Create the token cache plugin.
 * - Default: OS-level encrypted — Windows DPAPI (CurrentUser), macOS Keychain, Linux libsecret.
 * - FLOWFORGER_TOKEN_CACHE=file: a plain JSON file readable only by you (0600), for headless
 *   Linux where no unlocked keyring exists. Opt-in because the refresh token is then
 *   unencrypted on disk.
 */
export async function createCachePlugin(log: (msg: string) => void = () => {}): Promise<ICachePlugin> {
  let ext: typeof import('@azure/msal-node-extensions');
  try {
    ext = await import('@azure/msal-node-extensions');
  } catch (err) {
    throw new Error(tokenCacheUnavailableMessage(err));
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  if (process.env.FLOWFORGER_TOKEN_CACHE === 'file') {
    const persistence = await ext.FilePersistence.create(PLAINTEXT_CACHE_PATH);
    chmodSync(PLAINTEXT_CACHE_PATH, 0o600);
    log(`Auth: Using plaintext token cache ${PLAINTEXT_CACHE_PATH} (FLOWFORGER_TOKEN_CACHE=file)`);
    return new ext.PersistenceCachePlugin(persistence);
  }

  const creating = ext.PersistenceCreator.createPersistence({
    cachePath: CACHE_PATH,
    dataProtectionScope: ext.DataProtectionScope.CurrentUser,
    serviceName: 'FlowForger',
    accountName: 'TokenCache',
  });
  // Only Linux: the macOS Keychain can legitimately wait on an unlock dialog the user is
  // looking at, and DPAPI never blocks.
  const persistence =
    process.platform === 'linux'
      ? await withTimeout(creating, KEYRING_TIMEOUT_MS, () => new Error(keyringTimeoutMessage()))
      : await creating;

  log('Auth: Using OS-level encrypted token cache');
  return new ext.PersistenceCachePlugin(persistence);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function keyringTimeoutMessage(): string {
  return [
    `The system keyring did not respond within ${KEYRING_TIMEOUT_MS / 1000}s, so the encrypted token cache used by --auth is unavailable.`,
    'This usually means the keyring is locked and there is no desktop session to unlock it (WSL, SSH, CI).',
    'Either unlock it (e.g. start gnome-keyring-daemon --unlock), or use an unencrypted cache file readable only by you:',
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
  lines.push('Alternatively, skip --auth and pass tokens explicitly (--graph-token, --sp-token, --dv-token).');
  return lines.join('\n');
}
