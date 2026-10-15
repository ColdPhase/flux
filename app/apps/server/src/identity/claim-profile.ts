/**
 * Claim rules for the one chosen provider (F-024 S5b, #315; docs/product/mcp-identity.md AC-3). Pure functions: the
 * callback passes the verified ID token's claims, and gets a subject and an address back, or the reason it refused.
 * Mock or documented claim shapes exercise these rules; real-provider compatibility stays unverified until a
 * recorded integration run exists for that provider.
 *
 *  - generic OpenID Connect: `iss` equals the configured issuer, `sub` is the subject, `email_verified` is true.
 *  - Microsoft Entra ID: `iss` is https://login.microsoftonline.com/{tid}/v2.0 for the token's `tid`; `sub` is the
 *    pairwise subject for this client; Entra has no `email_verified`, so the address counts as verified only with the
 *    `xms_edov` (email domain owner verified) optional claim set to true.
 *  - Google: `iss` is https://accounts.google.com; `email_verified` must be true; with an allowed Workspace domain,
 *    `hd` must equal it (hd is absent for personal accounts).
 */

export type ProviderFamily = 'entra' | 'google' | 'generic';

export type ProfileResult =
  | { ok: true; subject: string; email: string; name: string | null }
  | { ok: false; reason: 'issuer' | 'subject' | 'email' | 'unverified' | 'tenant' | 'domain' };

const normalize = (value: string) => value.replace(/\/$/, '');

export function providerFamily(issuer: string): ProviderFamily {
  let host: string;
  try { host = new URL(issuer).hostname.toLowerCase(); } catch { return 'generic'; }
  if (host === 'login.microsoftonline.com' || host === 'sts.windows.net') return 'entra';
  if (host === 'accounts.google.com') return 'google';
  return 'generic';
}

export function profileFromClaims(issuer: string, claims: Record<string, unknown>, options: { allowedDomain?: string } = {}): ProfileResult {
  const family = providerFamily(issuer);
  const iss = typeof claims.iss === 'string' ? normalize(claims.iss) : '';
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const rawEmail = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!subject) return { ok: false, reason: 'subject' };
  if (family === 'entra') {
    // The token's own tenant must match its issuer, and a configured single tenant must be that tenant.
    const tid = typeof claims.tid === 'string' ? claims.tid : '';
    const issuerTenant = new URL(issuer).pathname.split('/').filter(Boolean)[0] ?? '';
    const named = issuerTenant && !['common', 'organizations', 'consumers'].includes(issuerTenant) ? issuerTenant : null;
    const expected = [`${new URL(issuer).origin}/${tid}/v2.0`, `https://sts.windows.net/${tid}/`];
    if (!tid || !expected.map(normalize).includes(iss) || (named !== null && named !== tid)) return { ok: false, reason: 'tenant' };
  } else if (iss !== normalize(issuer)) {
    return { ok: false, reason: 'issuer' };
  }
  if (!rawEmail) return { ok: false, reason: 'email' };
  if (family === 'entra') {
    if (claims.xms_edov !== true) return { ok: false, reason: 'unverified' };
  } else if (claims.email_verified !== true) {
    return { ok: false, reason: 'unverified' };
  }
  if (family === 'google' && options.allowedDomain && claims.hd !== options.allowedDomain) return { ok: false, reason: 'domain' };
  const name = [claims.name, claims.preferred_username].find((value): value is string => typeof value === 'string' && !!value.trim());
  return { ok: true, subject, email: rawEmail, name: name ? name.trim().slice(0, 200) : null };
}
