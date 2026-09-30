import { isIP } from 'node:net';

export interface SmtpConfig {
  url: string;
  from: string;
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
  };
}
