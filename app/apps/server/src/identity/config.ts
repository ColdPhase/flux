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
  /** How long the provider's last confirmation of a person keeps their access (F-024 S2, #312). */
  confirmationMaxAgeMs: number;
  /** `refresh` runs the standing check of the person's account at the provider (F-024 S4, #311); `off` keeps only logout and age. */
  standing: 'refresh' | 'off';
  /** How often a live identity is checked (default 15 minutes, FLUX_OIDC_STANDING_INTERVAL_SECONDS). */
  standingIntervalMs: number;
}

export const DEFAULT_STANDING_INTERVAL_SECONDS = 900;

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
  /**
   * `prepare` keeps password sign-in while the provider is set, so existing password accounts can link their
   * provider identity (F-024 S5b, #315). `sso` is the cutover: with a provider, ordinary authentication is SSO only.
   */
  ssoMode: 'prepare' | 'sso';
  /** With a provider in `sso` mode: password sign-in, sign-up, reset and password-only sessions are refused. */
  ssoOnly: boolean;
  /**
   * Who may create a password account (F-024 S5a, #313). `open` is today's behaviour; `verified` makes a new
   * account prove its address by mail before it can sign in; `off` closes password sign-up. `verified` without
   * SMTP cannot send that mail, and any sign-on provider makes password sign-up ordinary-closed (SSO-only mode),
   * so the effective value is `off` (`signupRequested` keeps what the operator asked for).
   */
  signup: 'open' | 'verified' | 'off';
  signupRequested: 'open' | 'verified' | 'off';
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

const HOUR_MS = 3_600_000;
export const DEFAULT_CONFIRMATION_MAX_AGE_MS = 7 * 24 * HOUR_MS;

/** `FLUX_OIDC_CONFIRMATION_MAX_AGE`: whole hours (`36h`) or days (`7d`), from 1h to 30d; empty means 7d. */
export function parseConfirmationMaxAge(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_CONFIRMATION_MAX_AGE_MS;
  const match = /^([1-9]\d{0,4})([hd])$/.exec(text);
  const ms = match ? Number(match[1]) * (match[2] === 'd' ? 24 : 1) * HOUR_MS : NaN;
  if (!(ms >= HOUR_MS && ms <= 30 * 24 * HOUR_MS)) throw new Error('FLUX_OIDC_CONFIRMATION_MAX_AGE must be from 1h to 30d, such as 12h or 7d');
  return ms;
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
  const standing = (env.FLUX_OIDC_STANDING ?? 'refresh').trim().toLowerCase();
  if (standing !== 'refresh' && standing !== 'off') throw new Error('FLUX_OIDC_STANDING must be refresh or off');
  const interval = Number(env.FLUX_OIDC_STANDING_INTERVAL_SECONDS?.trim() || DEFAULT_STANDING_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < 5 || interval > 86_400) throw new Error('FLUX_OIDC_STANDING_INTERVAL_SECONDS must be an integer from 5 to 86400');
  return { providerId: oidcProviderId(issuer), issuer, clientId: clientId!, clientSecret, label, standing, standingIntervalMs: interval * 1000,
    confirmationMaxAgeMs: parseConfirmationMaxAge(env.FLUX_OIDC_CONFIRMATION_MAX_AGE) };
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
  const requested = (env.FLUX_SIGNUP ?? 'open').trim().toLowerCase();
  if (requested !== 'open' && requested !== 'verified' && requested !== 'off') throw new Error('FLUX_SIGNUP must be open, verified or off');
  const oidc = loadOidcConfig(env);
  const mode = (env.FLUX_SSO_MODE ?? 'sso').trim().toLowerCase();
  if (mode !== 'prepare' && mode !== 'sso') throw new Error('FLUX_SSO_MODE must be prepare or sso');
  if (mode === 'prepare' && !oidc) throw new Error('FLUX_SSO_MODE=prepare needs a sign-on provider (FLUX_OIDC_ISSUER and FLUX_OIDC_CLIENT_ID)');
  return {
    publicOrigin,
    secret,
    signupRequested: requested,
    // In SSO-only mode password sign-up is closed; prepare mode keeps it as configured, since password accounts exist then.
    signup: (oidc && mode === 'sso') || (requested === 'verified' && !(smtpUrl && from)) ? 'off' : requested,
    ssoMode: mode,
    ssoOnly: oidc !== null && mode === 'sso',
    trustedProxies,
    smtp: smtpUrl && from ? { url: smtpUrl, from } : null,
    rateLimit: rateLimit === 'true',
    passwordResetTtlSeconds: ttl,
    oidc,
  };
}
