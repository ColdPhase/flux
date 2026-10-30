import { createPublicKey, verify } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import { createJwks } from './backchannel.js';
import { profileFromClaims, type ProfileResult } from './claim-profile.js';
import type { OidcConfig } from './config.js';

const algorithms: Record<string, { hash: string; kty: string; padding?: number; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' }, RS384: { hash: 'sha384', kty: 'RSA' }, RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', padding: 6 },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' }, ES384: { hash: 'sha384', kty: 'EC', dsaEncoding: 'ieee-p1363' },
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A refresh response can omit its ID token (OIDC Core §12). Only a verified one can change a profile. */
export function createStandingProfile(oidc: OidcConfig, jwks = createJwks(oidc), now = Date.now) {
  return async (token: string): Promise<ProfileResult> => {
    const invalid: ProfileResult = { ok: false, reason: 'issuer' };
    try {
      if (token.length > 16_384) return invalid;
      const parts = token.split('.');
      if (parts.length !== 3) return invalid;
      const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
      if (!object(header) || !object(claims) || typeof header.alg !== 'string' || header.crit !== undefined) return invalid;
      const algorithm = algorithms[header.alg];
      if (!algorithm) return invalid;
      const key = await jwks(typeof header.kid === 'string' ? header.kid : undefined, algorithm.kty);
      if (!key || (key.alg !== undefined && key.alg !== header.alg)) return invalid;
      if (!verify(algorithm.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {
        key: createPublicKey({ key, format: 'jwk' }),
        ...(algorithm.padding ? { padding: algorithm.padding } : {}),
        ...(algorithm.dsaEncoding ? { dsaEncoding: algorithm.dsaEncoding } : {}),
      }, Buffer.from(parts[2]!, 'base64url'))) return invalid;
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const seconds = now() / 1000;
      if (claims.iss !== oidc.issuer || !audience.includes(oidc.clientId)
        || (audience.length > 1 && claims.azp !== oidc.clientId) || (claims.azp !== undefined && claims.azp !== oidc.clientId)
        || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= seconds
        || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > seconds + 60
        || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > seconds + 60))) return invalid;
      return profileFromClaims(oidc.issuer, claims);
    } catch { return invalid; }
  };
}

/** Called in the successful lease's transaction. The subject is a key; an email never is. */
export async function updateStandingProfile(db: Pick<Database, 'transaction'>, userId: string, providerId: string,
  profile: Extract<ProfileResult, { ok: true }>, now: Date): Promise<'updated' | 'subject' | 'collision'> {
  try {
    // A savepoint isolates a concurrent email uniqueness collision from the stored rotation/confirmation.
    return await db.transaction(async (tx) => {
      const [account] = await tx.select({ id: schema.authAccounts.id }).from(schema.authAccounts).where(and(
        eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId), eq(schema.authAccounts.accountId, profile.subject))).for('share');
      if (!account) return 'subject' as const;
      const [holder] = await tx.select({ id: schema.authUsers.id }).from(schema.authUsers)
        .where(eq(sql`lower(${schema.authUsers.email})`, profile.email));
      if (holder && holder.id !== userId) return 'collision' as const;
      await tx.update(schema.authUsers).set({ email: profile.email, emailVerified: true, updatedAt: now,
        ...(profile.name ? { name: profile.name } : {}) }).where(eq(schema.authUsers.id, userId));
      return 'updated' as const;
    });
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505') return 'collision';
    throw error;
  }
}
