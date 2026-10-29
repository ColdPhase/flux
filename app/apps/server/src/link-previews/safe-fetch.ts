import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { classifyAddress } from '@flux/agent-runtime';
import { caresResolver, type HostResolver } from './resolver.js';

// The one way the server fetches a page for a link card (#469). The address in a message is attacker-chosen, so every rule that
// keeps the request away from the instance's own network lives here, in one place that the tests drive with real sockets:
//
// - only http and https, only the scheme's default port, no credentials in the address;
// - the host is resolved once, by the socket's own lookup (c-ares, never libuv's shared thread pool, `resolver.ts`): every address it returns must be public (private, loopback,
//   link-local, multicast, reserved, cloud metadata and IPv4-mapped forms are not), and the socket connects to that very
//   address, so a name that answers differently a moment later (DNS rebinding) cannot reach a private one;
// - a redirect (at most 3) is a new request judged by the same rules, and never carries anything from the first;
// - no cookies, no credentials, no Referer, no compression; one fixed User-Agent;
// - a connect timeout and one deadline for the whole fetch, redirects included; at most 256 KiB of a text/html body is read.

export const USER_AGENT = 'FluxLinkPreview/1 (+https://github.com/ColdPhase/flux)';
export const FETCH_LIMITS = { connectMs: 2_000, totalMs: 3_000, maxBytes: 256 * 1024, maxRedirects: 3 } as const;

type AddressClass = 'public' | 'private' | 'metadata';
export type FetchFailure = 'blocked' | 'unreachable' | 'timeout' | 'status' | 'type' | 'redirects' | 'invalid';
export type FetchResult = { ok: true; url: string; html: string } | { ok: false; reason: FetchFailure };

export interface FetchRules {
  resolve: HostResolver;
  classify: (address: string) => AddressClass;
  /** The port to connect to for this address, or null to refuse it. */
  port: (url: URL) => number | null;
  limits: { connectMs: number; totalMs: number; maxBytes: number; maxRedirects: number };
}

/** The production rules: the c-ares resolver (off the shared thread pool), the address classes of `classifyAddress`, and default ports only. */
export const PRODUCTION_RULES: FetchRules = {
  resolve: caresResolver(),
  classify: classifyAddress,
  port: (url) => (url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : null),
  limits: FETCH_LIMITS,
};

/** Names that are the instance's own network whatever DNS says. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|lan|home\.arpa)$/i;
/** The host as the socket will use it: no brackets of an IPv6 literal, lower case, no trailing dot (`localhost.` is `localhost`). */
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();

/** The reason an address may not be fetched before any DNS or socket is used, or null. */
export function literalRefusal(url: URL, rules: FetchRules): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (url.username || url.password) return true;
  const host = hostOf(url);
  if (!host || rules.port(url) === null) return true;
  if (isIP(host)) return rules.classify(host) !== 'public';
  return LOCAL_NAME.test(host);
}

class Refused extends Error {
  constructor(readonly failure: FetchFailure) { super(failure); }
}

/**
 * The socket's lookup: resolves the host now, refuses unless every answer is public, and hands the socket that answer. Because the
 * connection uses the addresses checked here, there is no second resolution a hostile DNS server could answer differently.
 * `connectTo` is the test deployment's mock (config `testHosts`): that one named host connects to the mock without the address check.
 */
export function guardedLookup(rules: FetchRules, connectTo?: { host: string; port: number } | null): LookupFunction {
  return (hostname, options, callback) => {
    const host = connectTo?.host ?? hostname.replace(/^\[|\]$/g, '').toLowerCase();
    rules.resolve(host).then((addresses: LookupAddress[]) => {
      const usable = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
      if (!usable.length) return callback(new Refused('unreachable'), '', 0);
      if (!connectTo && usable.some((entry) => rules.classify(entry.address) !== 'public')) return callback(new Refused('blocked'), '', 0);
      if (options.all) return (callback as unknown as (error: null, list: LookupAddress[]) => void)(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    }, () => callback(new Refused('unreachable'), '', 0));
  };
}

const failureOf = (error: unknown): FetchFailure => {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof Refused) return current.failure;
  }
  return 'unreachable';
};

const charsetOf = (contentType: string) => /charset\s*=\s*"?([a-z0-9_.:-]+)/i.exec(contentType)?.[1] ?? null;

function decode(bytes: Buffer, contentType: string): string {
  const label = charsetOf(contentType) ?? /<meta[^>]+charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(bytes.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); } catch { return bytes.toString('utf8'); }
}

type Hop = { kind: 'page'; html: string } | { kind: 'redirect'; location: string };

/** One request, no redirect followed. Resolves with the page body or the redirect target; rejects with a `Refused`. */
function requestOnce(url: URL, rules: FetchRules, signal: AbortSignal, connectTo: { host: string; port: number } | null): Promise<Hop> {
  const port = connectTo?.port ?? rules.port(url)!;
  const secure = url.protocol === 'https:';
  return new Promise<Hop>((resolve, reject) => {
    if (signal.aborted) return reject(new Refused('timeout'));
    let settled = false;
    const done = (error: Refused | null, hop?: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', onAbort);
      outgoing.destroy();
      if (error) reject(error); else resolve(hop!);
    };
    const outgoing = (secure ? https : http).request({
      protocol: url.protocol, hostname: hostOf(url), port, method: 'GET', path: `${url.pathname}${url.search}`, agent: false,
      // The Host header and the certificate name stay the address's own even when a test deployment connects elsewhere.
      servername: secure && !isIP(hostOf(url)) ? hostOf(url) : undefined,
      headers: { host: url.host, 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity', connection: 'close' },
      lookup: guardedLookup(rules, connectTo),
    }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      const type = String(incoming.headers['content-type'] ?? '').toLowerCase();
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = incoming.headers.location;
        incoming.destroy();
        return location ? done(null, { kind: 'redirect', location }) : done(new Refused('status'));
      }
      if (status !== 200) { incoming.destroy(); return done(new Refused('status')); }
      if (!/^(text\/html|application\/xhtml\+xml)\b/.test(type)) { incoming.destroy(); return done(new Refused('type')); }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        const room = rules.limits.maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        // The head of a page is all that is read; the rest is never downloaded.
        if (size >= rules.limits.maxBytes) { incoming.destroy(); done(null, { kind: 'page', html: decode(Buffer.concat(chunks), type) }); }
      });
      incoming.on('end', () => done(null, { kind: 'page', html: decode(Buffer.concat(chunks), type) }));
      incoming.on('error', () => done(settled ? null : new Refused('unreachable')));
    });
    const onAbort = () => done(new Refused('timeout'));
    // Until the socket is connected only the connect timeout runs; after it, the deadline of the whole fetch.
    const connectTimer = setTimeout(() => done(new Refused('timeout')), rules.limits.connectMs);
    outgoing.on('socket', (socket) => {
      const connected = () => clearTimeout(connectTimer);
      if (socket.connecting) socket.once(secure ? 'secureConnect' : 'connect', connected); else connected();
    });
    outgoing.on('error', (error) => done(new Refused(failureOf(error))));
    signal.addEventListener('abort', onAbort, { once: true });
    outgoing.end();
  });
}

/** Fetches the page at `address`: the start of its HTML, or why not. Never throws. */
export async function fetchPage(address: string, rules: FetchRules = PRODUCTION_RULES, connectTo?: (host: string) => { host: string; port: number } | null): Promise<FetchResult> {
  const deadline = AbortSignal.timeout(rules.limits.totalMs);
  let url: URL;
  try { url = new URL(address); } catch { return { ok: false, reason: 'invalid' }; }
  try {
    for (let hop = 0; hop <= rules.limits.maxRedirects; hop++) {
      if (literalRefusal(url, rules)) return { ok: false, reason: 'blocked' };
      const result = await requestOnce(url, rules, deadline, connectTo?.(hostOf(url)) ?? null);
      if (result.kind === 'page') return { ok: true, url: url.href, html: result.html };
      try { url = new URL(result.location, url); } catch { return { ok: false, reason: 'invalid' }; }
    }
    return { ok: false, reason: 'redirects' };
  } catch (error) {
    return { ok: false, reason: error instanceof Refused ? error.failure : 'unreachable' };
  }
}

/**
 * The rules of a test deployment (config `testHosts`): no real site can be reached. A name with a dot is not resolved at all
 * (so a run does not even send a DNS query for it), a single-label name (a Compose service) is, and whatever it resolves to
 * counts as non-public. Only the hosts named in `testHosts` connect, to their mock.
 */
const closedWorldResolve = caresResolver();
export const CLOSED_WORLD_RULES: FetchRules = {
  ...PRODUCTION_RULES,
  classify: () => 'private',
  resolve: (host) => (/^[a-z0-9-]+$/.test(host) ? closedWorldResolve(host) : Promise.reject(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))),
};
