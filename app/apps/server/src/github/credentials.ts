import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { githubRows, schema } from '@flux/db';
import { githubId, ServiceUnavailableError, type Database } from '@flux/core';
import type { GithubConfig } from './config.js';
import { seal, unseal } from './crypto.js';
import { apiHeaders, type GithubTransport, providerText } from './http.js';
import { githubTransaction } from './transactions.js';
interface Tokens { accessToken: string; refreshToken: string | null }
interface Credential { token: string; githubUserId: string; appId: string; authorizationGeneration: string }
function seconds(value: unknown, fallback: number | null) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 31_536_000) throw new ServiceUnavailableError('Invalid GitHub token lifetime', 'GITHUB_INVALID_RESPONSE');
  return new Date(Date.now() + Number(value) * 1000).getTime();
}
const envelope = (userId: string, generation: string, githubUserId: string, config: GithubConfig) =>
  JSON.stringify(['github-credential:v2', 'github.com', config.appId, config.clientId, userId, githubUserId, generation]);
export function githubCredentials(db: Database, config: GithubConfig, transport: GithubTransport) {
  const c = schema.githubCredentials;
  function tokenReply(raw: Record<string, unknown>) {
    if (raw.error || raw.token_type !== 'bearer' || (raw.scope !== undefined && raw.scope !== '')) throw new ServiceUnavailableError('GitHub authorization failed', 'GITHUB_AUTHORIZATION_FAILED');
    const accessToken = providerText(raw.access_token, 1000);
    if (!accessToken.startsWith('ghu_')) throw new ServiceUnavailableError('A GitHub App user token is required', 'GITHUB_INVALID_RESPONSE');
    const refreshToken = raw.refresh_token === undefined ? null : providerText(raw.refresh_token, 1000);
    const expires = seconds(raw.expires_in, null); const refreshExpires = seconds(raw.refresh_token_expires_in, null);
    if (expires !== null && (!refreshToken || refreshExpires === null)) throw new ServiceUnavailableError('GitHub refresh information is incomplete', 'GITHUB_INVALID_RESPONSE');
    return { tokens: { accessToken, refreshToken }, expiresAt: expires === null ? null : new Date(expires), refreshExpiresAt: refreshExpires === null ? null : new Date(refreshExpires) };
  }
  const credentials = {
    async store(userId: string, raw: Record<string, unknown>, guard?: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<void>) {
      const parsed = tokenReply(raw);
      const { data: profile } = await transport.json('https://api.github.com/user', { headers: apiHeaders(parsed.tokens.accessToken) });
      const githubUserId = githubId(profile.id); const generation = randomUUID();
      await githubTransaction(db, async (tx) => {
        await guard?.(tx);
        await tx.insert(c).values({ userId, host: 'github.com', githubUserId, generation, appId: config.appId,
          encryptedTokens: seal(config.encryptionKey, JSON.stringify(parsed.tokens), envelope(userId, generation, githubUserId, config)),
          expiresAt: parsed.expiresAt, refreshExpiresAt: parsed.refreshExpiresAt, state: 'active' }).onConflictDoUpdate({
          target: [c.userId, c.host], set: { githubUserId, generation, appId: config.appId,
            encryptedTokens: seal(config.encryptionKey, JSON.stringify(parsed.tokens), envelope(userId, generation, githubUserId, config)),
            expiresAt: parsed.expiresAt, refreshExpiresAt: parsed.refreshExpiresAt, state: 'active', updatedAt: new Date() },
        });
      });
      return { githubUserId, generation };
    },
    async state(userId: string) {
      return githubTransaction(db, async (tx) => {
        const [row] = await tx.select().from(c).where(and(eq(c.userId, userId), eq(c.host, 'github.com'), eq(c.appId, config.appId)));
        if (!row?.encryptedTokens) return 'required' as const;
        try { unseal(config.encryptionKey, row.encryptedTokens, envelope(userId, row.generation, row.githubUserId, config)); }
        catch { return 'required' as const; } // old or differently configured envelopes require explicit reconnect
        return row?.state === 'active' ? 'connected' as const : row?.state === 'uncertain' || row?.state === 'refreshing' ? 'uncertain' as const : 'required' as const;
      });
    },
    async token(userId: string) {
      const prepared = await githubTransaction(db, async (tx) => {
        const [row] = await tx.select().from(c).where(and(eq(c.userId, userId), eq(c.host, 'github.com'))).for('update');
        if (!row || row.state !== 'active' || row.appId !== config.appId || !row.encryptedTokens)
          throw new ServiceUnavailableError('Authorize GitHub for this account', 'GITHUB_AUTHORIZATION_REQUIRED');
        let tokens: Tokens;
        try { tokens = JSON.parse(unseal(config.encryptionKey, row.encryptedTokens, envelope(userId, row.generation, row.githubUserId, config))) as Tokens; }
        catch { throw new ServiceUnavailableError('Reconnect GitHub to restore credentials', 'GITHUB_AUTHORIZATION_REQUIRED'); }
        const refresh = row.expiresAt !== null && row.expiresAt.getTime() < Date.now() + 30_000;
        if (refresh) {
          if (!tokens.refreshToken || !row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= Date.now())
            throw new ServiceUnavailableError('Authorize GitHub again', 'GITHUB_AUTHORIZATION_REQUIRED');
          // Commit the refresh fence before a potentially consumed external token leaves Flux.
          await tx.update(c).set({ state: 'refreshing', updatedAt: new Date() }).where(eq(c.userId, userId));
        }
        return { row, tokens, refresh };
      });
      let tokens = prepared.tokens;
      if (prepared.refresh) {
        try {
          const { data } = await transport.json('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refreshToken }) });
          const next = tokenReply(data);
          const changed = await githubTransaction(db, async (tx) => tx.update(c).set({ state: 'active', expiresAt: next.expiresAt, refreshExpiresAt: next.refreshExpiresAt,
            encryptedTokens: seal(config.encryptionKey, JSON.stringify(next.tokens), envelope(userId, prepared.row.generation, prepared.row.githubUserId, config)), updatedAt: new Date() })
            .where(and(eq(c.userId, userId), eq(c.appId, config.appId), eq(c.generation, prepared.row.generation), eq(c.state, 'refreshing'))).returning({ id: c.userId }));
          if (!changed.length) throw new Error('authorization changed');
          tokens = next.tokens;
        } catch {
          await githubTransaction(db, async (tx) => tx.update(c).set({ state: 'uncertain', updatedAt: new Date() })
            .where(and(eq(c.userId, userId), eq(c.generation, prepared.row.generation), eq(c.state, 'refreshing'))));
          throw new ServiceUnavailableError('Reconnect GitHub after an uncertain refresh', 'GITHUB_REFRESH_UNCERTAIN');
        }
      }
      return { token: tokens.accessToken, githubUserId: prepared.row.githubUserId, appId: prepared.row.appId, authorizationGeneration: prepared.row.generation };
    },
    async revoke(userId: string) {
      await githubTransaction(db, async (tx) => {
        await tx.update(c).set({ state: 'revoked', encryptedTokens: null, updatedAt: new Date() }).where(eq(c.userId, userId));
        const bindings = await tx.update(schema.githubBindings).set({ state: 'revoked' }).where(eq(schema.githubBindings.authorUserId, userId)).returning({ id: schema.githubBindings.id });
        // Task rules reading these repositories pause until someone resumes them (#74 G-1a).
        await githubRows(tx).suspendRulesFor(bindings.map((binding) => binding.id), userId);
      });
    },
    forTransaction(tx: Database): { token(userId: string): Promise<Credential> } {
      const pinned = new Map<string, Promise<Credential>>();
      return { token(userId) {
        let ready = pinned.get(userId);
        if (!ready) {
          ready = (async () => {
            // This first preflight is before binding locks; refresh keeps its committed fence.
            const preflight = await credentials.token(userId);
            const [row] = await tx.select().from(c).where(and(eq(c.userId, userId), eq(c.host, 'github.com'))).for('share');
            if (!row || row.state !== 'active' || row.appId !== config.appId || row.generation !== preflight.authorizationGeneration
              || row.githubUserId !== preflight.githubUserId || !row.encryptedTokens || (row.expiresAt && row.expiresAt.getTime() <= Date.now()))
              throw new ServiceUnavailableError('GitHub authorization changed; reconnect or retry', 'GITHUB_AUTHORIZATION_REQUIRED');
            let tokens: Tokens;
            try { tokens = JSON.parse(unseal(config.encryptionKey, row.encryptedTokens, envelope(userId, row.generation, row.githubUserId, config))) as Tokens; }
            catch { throw new ServiceUnavailableError('Reconnect GitHub to restore credentials', 'GITHUB_AUTHORIZATION_REQUIRED'); }
            return { token: tokens.accessToken, githubUserId: row.githubUserId, appId: row.appId, authorizationGeneration: row.generation };
          })();
          pinned.set(userId, ready);
        }
        return ready;
      } };
    },
  };
  return credentials;
}
export type GithubCredentials = ReturnType<typeof githubCredentials>;
