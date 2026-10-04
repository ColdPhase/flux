import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export interface SmtpConfig {
  url: string;
  from: string;
}

/**
 * One optional operator-configured OpenID Connect provider for human sign-in (#113). Group,
 * domain or role claims never become Flux grants; the provider id is derived from the issuer so a
 * changed issuer can never reuse an existing identity namespace.
 */
export interface OidcConfig {
  providerId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
}

export interface IdentityConfig {
  /** The only origin browsers may use for state-changing requests, e.g. https://flux.example.org. */
  publicOrigin: string;
  secret: string;
  /** Reverse-proxy addresses or CIDR ranges whose X-Forwarded-For is believed. Empty trusts none. */
  trustedProxies: string[];
  /** Null means password reset is reported as unavailable. */
  smtp: SmtpConfig | null;
  rateLimit: boolean;
  passwordResetTtlSeconds: number;
  /** Null keeps email/password sign-in only. */
  oidc: OidcConfig | null;
}

function isAddressOrRange(value: string) {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

function isLoopbackHost(hostname: string) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIP(hostname) === 4 && hostname.split('.')[0] === '127';
}

export function parsePublicOrigin(value: string | undefined): string {
  if (!value) throw new Error('FLUX_PUBLIC_ORIGIN is required, e.g. https://flux.example.org');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FLUX_PUBLIC_ORIGIN must be an absolute http(s) origin');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('FLUX_PUBLIC_ORIGIN must use http or https');
  if (url.origin !== value.replace(/\/$/, '')) throw new Error('FLUX_PUBLIC_ORIGIN must be an origin without path, query or credentials');
  // Session cookies are only Secure over https, so plain http is limited to local development.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('FLUX_PUBLIC_ORIGIN must use https unless it is a loopback address (localhost, 127.0.0.0/8 or [::1])');
  }
  return url.origin;
}

export function oidcProviderId(issuer: string) {
  return `oidc-${createHash('sha256').update(issuer).digest('hex').slice(0, 12)}`;
}

/**
 * FLUX_OIDC_ISSUER and FLUX_OIDC_CLIENT_ID are both set or both empty; FLUX_OIDC_CLIENT_SECRET_FILE
 * names the client secret then.
 * The issuer must be https; plain http is accepted only for a loopback host or when
 * FLUX_OIDC_ALLOW_HTTP_ISSUER=true (an isolated test identity provider, never production).
 */
export function loadOidcConfig(env: NodeJS.ProcessEnv, readSecret: (path: string) => string = (path) => readFileSync(path, 'utf8')): OidcConfig | null {
  const issuerValue = env.FLUX_OIDC_ISSUER?.trim();
  const clientId = env.FLUX_OIDC_CLIENT_ID?.trim();
  const secretFile = env.FLUX_OIDC_CLIENT_SECRET_FILE?.trim();
  // The secret path is always set by the Compose files; issuer and client id switch sign-on on.
  const set = [issuerValue, clientId].filter(Boolean).length;
  if (set === 0) return null;
  if (set !== 2) throw new Error('Set FLUX_OIDC_ISSUER and FLUX_OIDC_CLIENT_ID together, or neither');
  if (!secretFile) throw new Error('FLUX_OIDC_CLIENT_SECRET_FILE is required for single sign-on');
  let url: URL;
  try {
    url = new URL(issuerValue!);
  } catch {
    throw new Error('FLUX_OIDC_ISSUER must be an absolute URL');
  }
  if (url.search || url.hash || url.username || url.password) throw new Error('FLUX_OIDC_ISSUER must not have a query, fragment or credentials');
  const allowHttp = (env.FLUX_OIDC_ALLOW_HTTP_ISSUER ?? 'false').trim().toLowerCase();
  if (allowHttp !== 'true' && allowHttp !== 'false') throw new Error('FLUX_OIDC_ALLOW_HTTP_ISSUER must be true or false');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLoopbackHost(url.hostname) || allowHttp === 'true'))) {
    throw new Error('FLUX_OIDC_ISSUER must use https');
  }
  const issuer = issuerValue!.replace(/\/$/, '');
  let clientSecret: string;
  try {
    clientSecret = readSecret(secretFile!).trim();
  } catch {
    throw new Error('FLUX_OIDC_CLIENT_SECRET_FILE cannot be read');
  }
  if (!clientSecret) throw new Error('FLUX_OIDC_CLIENT_SECRET_FILE is empty');
  const label = env.FLUX_OIDC_LABEL?.trim() || 'single sign-on';
  if (label.length > 60) throw new Error('FLUX_OIDC_LABEL must be at most 60 characters');
  return { providerId: oidcProviderId(issuer), issuer, clientId: clientId!, clientSecret, label };
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const publicOrigin = parsePublicOrigin(env.FLUX_PUBLIC_ORIGIN);
  const secret = env.FLUX_AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('FLUX_AUTH_SECRET must be at least 32 characters');
  const trustedProxies = (env.FLUX_TRUSTED_PROXIES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of trustedProxies) {
    if (!isAddressOrRange(entry)) throw new Error(`FLUX_TRUSTED_PROXIES entry is not an IP address or CIDR range: ${entry}`);
  }
  const smtpUrl = env.FLUX_SMTP_URL?.trim();
  const from = env.FLUX_MAIL_FROM?.trim();
  if (smtpUrl && !from) throw new Error('FLUX_MAIL_FROM is required when FLUX_SMTP_URL is set');
  const ttl = Number(env.FLUX_PASSWORD_RESET_TTL_SECONDS ?? 3600);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new Error('FLUX_PASSWORD_RESET_TTL_SECONDS must be an integer from 60 to 86400');
  const rateLimit = (env.FLUX_AUTH_RATE_LIMIT ?? 'true').trim().toLowerCase();
  if (rateLimit !== 'true' && rateLimit !== 'false') throw new Error('FLUX_AUTH_RATE_LIMIT must be true or false');
  return {
    publicOrigin,
    secret,
    trustedProxies,
    smtp: smtpUrl && from ? { url: smtpUrl, from } : null,
    rateLimit: rateLimit === 'true',
    passwordResetTtlSeconds: ttl,
    oidc: loadOidcConfig(env),
  };
}
