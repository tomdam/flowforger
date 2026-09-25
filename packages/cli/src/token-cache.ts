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
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CACHE_DIR = join(homedir(), '.flowforger');
export const CACHE_PATH = join(CACHE_DIR, 'token-cache.json');

/**
 * Create an OS-level encrypted cache plugin.
 * - Windows: DPAPI encryption (CurrentUser scope)
 * - macOS: Keychain
 * - Linux: libsecret
 */
export async function createCachePlugin(log: (msg: string) => void = () => {}): Promise<ICachePlugin> {
  let ext: typeof import('@azure/msal-node-extensions');
  try {
    ext = await import('@azure/msal-node-extensions');
  } catch (err) {
    throw new Error(tokenCacheUnavailableMessage(err));
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const persistence = await ext.PersistenceCreator.createPersistence({
    cachePath: CACHE_PATH,
    dataProtectionScope: ext.DataProtectionScope.CurrentUser,
    serviceName: 'FlowForger',
    accountName: 'TokenCache',
  });

  log('Auth: Using OS-level encrypted token cache');
  return new ext.PersistenceCachePlugin(persistence);
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
