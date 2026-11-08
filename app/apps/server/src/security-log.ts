import { createHmac } from 'node:crypto';

/**
 * The security event log (#997; OWASP ASVS 4.0.3 V7.1.3, V7.2.1, V7.2.2, V8.1.4). One structured line for each event an operator watches for:
 * a failed or limited sign-in, a password or session change, a consent decision, a refused request, a space locked or unlocked. Every line is
 * `{ channel: 'security', event, outcome, reason?, userId?, account?, ip?, reqId?, … }`, so an operator filters on `"channel":"security"` and
 * alerts on `event` and `outcome` (docs/operations/monitoring.md#security-events).
 *
 * What a line never holds: a password, a token, a recovery code, a request body, a query string, a name, an address or any content (F-030).
 * A person is `userId`; an address that may belong to nobody (a failed sign-in) is `account`, a keyed hash that is the same for the same
 * address, so repeated guesses at one account can be counted without the log holding the address. `reason` is a short code.
 */
export type SecurityEventName =
  | 'sign_in' | 'rate_limited' | 'password_reset_requested' | 'password_reset' | 'password_changed' | 'email_changed' | 'sessions_revoked'
  | 'oauth_consent' | 'oauth_token' | 'client_disconnected' | 'origin_refused' | 'access_denied' | 'space_lock' | 'space_unlock';
export type SecurityOutcome = 'success' | 'failure' | 'allowed' | 'denied' | 'refused' | 'limited' | 'sampled';

export interface SecurityEvent {
  event: SecurityEventName;
  outcome: SecurityOutcome;
  /** A short code such as `bad_credentials` or `ORIGIN_MISMATCH`; anything else is logged as `other`. */
  reason?: string;
  userId?: string;
  /** `accountKey` of the address a sign-in or reset named. */
  account?: string;
  ip?: string;
  reqId?: string;
  /** The OAuth client's public identifier. */
  clientId?: string;
  workspaceId?: string;
  /** The path of an auth route, or the route template (`/api/v1/projects/:projectId`) of a refused request; never the real URL or its query. */
  route?: string;
  count?: number;
}

export interface SecurityLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;
// `<token>` is what the request log writes for a link token in a path (`loggedPath`, #1030); nothing else with angle brackets is a route.
const SAFE_ROUTE = /^([A-Z]{3,7} )?\/(?:[A-Za-z0-9_.:/@*-]|<token>){0,200}$/;
const WARNING: ReadonlySet<SecurityOutcome> = new Set(['failure', 'denied', 'refused', 'limited', 'sampled']);

export function securityEvent(log: SecurityLogger, event: SecurityEvent): void {
  const line: Record<string, unknown> = { channel: 'security', event: event.event, outcome: event.outcome };
  if (event.reason !== undefined) line.reason = SAFE_REASON.test(event.reason) ? event.reason : 'other';
  if (event.route !== undefined) line.route = SAFE_ROUTE.test(event.route) ? event.route : 'other';
  for (const key of ['userId', 'account', 'ip', 'reqId', 'clientId', 'workspaceId', 'count'] as const) if (event[key] !== undefined) line[key] = event[key];
  log[WARNING.has(event.outcome) ? 'warn' : 'info'](line, `Security event: ${event.event} ${event.outcome}`);
}

/** A keyed hash of a sign-in address: stable for one address, no way back to it. */
export function accountKey(secret: string, email: string): string {
  return createHmac('sha256', secret).update('flux-security-log\0').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** The code of an error as a reason: a domain or PostgreSQL code, else `error`. Never its message. */
export function errorReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SAFE_REASON.test(code) ? code : 'error';
}

/** Runs `work`, then records its success; a failure is recorded with its code and thrown again. */
export async function audited<T>(log: SecurityLogger, event: Omit<SecurityEvent, 'outcome' | 'reason'>, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    securityEvent(log, { ...event, outcome: 'success' });
    return result;
  } catch (error) {
    securityEvent(log, { ...event, outcome: 'failure', reason: errorReason(error) });
    throw error;
  }
}

// --- Refused requests --------------------------------------------------------------------------------------------------------

/** Who a request is: set when its session was resolved, read when it is refused. */
const principals = new WeakMap<object, string>();
export const rememberPrincipal = (request: object, userId: string) => { principals.set(request, userId); };
export const principalOf = (request: object): string | undefined => principals.get(request);

const WINDOW_MS = 60_000;
const PER_WINDOW = 10;
const MAX_KEYS = 5_000;

/**
 * Bounds the log of refused requests: the first ten per person (or address, before a session) per minute are logged, the eleventh is logged
 * once as `sampled`, and the rest of that minute is counted but not written. One probing person cannot fill the log.
 */
export function createDenialSampler(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): 'log' | 'summary' | 'skip' => {
    const at = now();
    let window = windows.get(key);
    if (!window || at - window.start >= WINDOW_MS) {
      if (windows.size >= MAX_KEYS) windows.clear();
      window = { start: at, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return window.count <= PER_WINDOW ? 'log' : window.count === PER_WINDOW + 1 ? 'summary' : 'skip';
  };
}

const sampler = createDenialSampler();

/** A 403 from the access policy: who, which route (the template, so no ids of content and no query), and the policy's code. */
export function accessDenied(request: { log: SecurityLogger; ip: string; method: string; routeOptions?: { url?: string } }, code: string): void {
  const userId = principalOf(request);
  const verdict = sampler(userId ?? request.ip);
  if (verdict === 'skip') return;
  securityEvent(request.log, { event: 'access_denied', outcome: verdict === 'log' ? 'denied' : 'sampled', reason: verdict === 'log' ? code : 'more_this_minute',
    userId, ip: request.ip, route: `${request.method} ${request.routeOptions?.url ?? '/'}` });
}
