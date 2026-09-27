import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountInfo, AuthenticationResult } from '@azure/msal-node';
import { acquireTokenSilentAnyAccount, deferredLog } from '../auth.js';

/**
 * The token cache file is shared across configs, so after signing in to two tenants it
 * holds two accounts. Silent acquisition must not stop at accounts[0] (the other tenant's
 * account), or every run falls back to a device-code login.
 */
const account = (username: string, tenantId: string): AccountInfo =>
  ({ username, tenantId, homeAccountId: `oid-${username}.${tenantId}` }) as AccountInfo;

function fakePca(accounts: AccountInfo[], worksFor: string[]) {
  const tried: string[] = [];
  const pca = {
    getTokenCache: () => ({ getAllAccounts: async () => accounts }),
    acquireTokenSilent: async ({ account }: { account: AccountInfo }) => {
      tried.push(account.username);
      if (!worksFor.includes(account.username)) throw new Error(`no token for ${account.username}`);
      return { accessToken: `token-${account.username}` } as AuthenticationResult;
    },
  };
  return { pca: pca as any, tried };
}

const work = account('me@work.com', 'tenant-work');
const demo = account('me@demo.net', 'tenant-demo');

describe('acquireTokenSilentAnyAccount', () => {
  it("tries the configured tenant's account first, even when it is not accounts[0]", async () => {
    const { pca, tried } = fakePca([work, demo], ['me@demo.net']);
    const result = await acquireTokenSilentAnyAccount(pca, ['s'], 'tenant-demo');
    assert.equal(result.accessToken, 'token-me@demo.net');
    assert.deepEqual(tried, ['me@demo.net']);
  });

  it('matches the tenant through homeAccountId when tenantId is not set on the account', async () => {
    const demoNoTid = { ...demo, tenantId: '' } as AccountInfo;
    const { pca, tried } = fakePca([work, demoNoTid], ['me@demo.net']);
    await acquireTokenSilentAnyAccount(pca, ['s'], 'tenant-demo');
    assert.deepEqual(tried, ['me@demo.net']);
  });

  it("falls back to other accounts when the tenant's own account fails (e.g. a guest)", async () => {
    const { pca, tried } = fakePca([demo, work], ['me@work.com']);
    const result = await acquireTokenSilentAnyAccount(pca, ['s'], 'tenant-demo');
    assert.equal(result.accessToken, 'token-me@work.com');
    assert.deepEqual(tried, ['me@demo.net', 'me@work.com']);
  });

  it('throws when no cached account works, so the caller can go interactive', async () => {
    const { pca } = fakePca([work, demo], []);
    await assert.rejects(acquireTokenSilentAnyAccount(pca, ['s'], 'tenant-demo'), /no token for me@work.com/);
  });

  it('throws when the cache is empty', async () => {
    const { pca } = fakePca([], []);
    await assert.rejects(acquireTokenSilentAnyAccount(pca, ['s'], 'tenant-demo'), /No cached account/);
  });
});

/**
 * `--auth` progress lines are noise when every token comes from the cache (they showed on camera
 * in the promo recordings), but useful context before a device-code sign-in or an error.
 */
describe('deferredLog', () => {
  it('holds lines until flushed, then prints them in order and passes later ones through', () => {
    const out: string[] = [];
    const { log, flush } = deferredLog((m) => out.push(m));
    log('a');
    log('b');
    assert.deepEqual(out, []);
    flush();
    assert.deepEqual(out, ['a', 'b']);
    log('c');
    flush();
    assert.deepEqual(out, ['a', 'b', 'c']);
  });

  it('prints nothing when never flushed (all tokens cached)', () => {
    const out: string[] = [];
    deferredLog((m) => out.push(m)).log('Auth: Acquiring tokens for 1 resource(s)...');
    assert.deepEqual(out, []);
  });

  it('passes everything straight through with verbose', () => {
    const out: string[] = [];
    deferredLog((m) => out.push(m), true).log('a');
    assert.deepEqual(out, ['a']);
  });
});
