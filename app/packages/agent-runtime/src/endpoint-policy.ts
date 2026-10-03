import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// The SSRF guard of owner AI connections (F-020 PROV-4). An owner can set the base URL of an
// OpenAI-compatible endpoint, and the worker sends the owner's key and project excerpts there, so
// the URL must never reach the instance's own network by default:
//
// - public HTTPS only; plain HTTP and private, loopback, link-local, unique-local (ULA), CGNAT,
//   reserved and multicast addresses only for targets the instance operator allowlists in
//   `FLUX_AI_PRIVATE_TARGETS` (host names, addresses or CIDR ranges);
// - cloud metadata addresses never, not even when allowlisted;
// - the host is resolved and every address checked when a connection is saved, and again by the
//   socket's own lookup when a request connects, so a DNS answer that changes in between (DNS
//   rebinding) is refused at the connection that would use it.
//
// Redirects are never followed and responses are bounded in size and time (`guarded-fetch.ts`).

/** The operator's explicit private targets. Empty by default: public HTTPS only. */
export interface AiEndpointPolicy {
  readonly hosts: ReadonlySet<string>;
  readonly ranges: BlockList;
  /** The entries as configured, for diagnostics; never key material. */
  readonly entries: readonly string[];
}

export const PRIVATE_TARGETS_ENV = 'FLUX_AI_PRIVATE_TARGETS';

const NON_PUBLIC: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  // ::/96 holds the unspecified and loopback addresses and the deprecated IPv4-compatible form; ::ffff:0:0/96
  // any IPv4-mapped form left unnormalized, and ::ffff:0:0:0/96 the IPv4-translated one. None is a public endpoint.
  ['::', 96, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'], ['::ffff:0:0:0', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['2001::', 32, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ['fec0::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
];
/** Instance metadata services: refused even when an operator allowlists their range. */
const METADATA: [string, 'ipv4' | 'ipv6'][] = [
  ['169.254.169.254', 'ipv4'], ['169.254.170.2', 'ipv4'], ['169.254.169.253', 'ipv4'], ['100.100.100.200', 'ipv4'],
  ['168.63.129.16', 'ipv4'], ['fd00:ec2::254', 'ipv6'],
];
const nonPublic = new BlockList();
for (const [address, prefix, family] of NON_PUBLIC) nonPublic.addSubnet(address, prefix, family);
const metadata = new BlockList();
for (const [address, family] of METADATA) metadata.addAddress(address, family);

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Parses `FLUX_AI_PRIVATE_TARGETS`: comma- or space-separated host names (exact match), IP
 * addresses or CIDR ranges. A malformed entry stops startup instead of widening access silently.
 */
export function parsePrivateTargets(value: string | undefined): AiEndpointPolicy {
  const hosts = new Set<string>();
  const ranges = new BlockList();
  const entries = (value ?? '').split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  for (const raw of entries) {
    const entry = raw.toLowerCase();
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address!);
    if (family && extra === undefined) {
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) { ranges.addAddress(address!, type); continue; }
      const bits = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || bits > (family === 6 ? 128 : 32)) throw new Error(`${PRIVATE_TARGETS_ENV}: invalid range ${raw}`);
      ranges.addSubnet(address!, bits, type);
    } else if (prefix === undefined && HOST.test(entry)) {
      hosts.add(entry);
    } else {
      throw new Error(`${PRIVATE_TARGETS_ENV}: invalid entry ${raw} (use host names, IP addresses or CIDR ranges)`);
    }
  }
  return { hosts, ranges, entries };
}

export const PUBLIC_ONLY: AiEndpointPolicy = parsePrivateTargets('');

export function aiEndpointPolicyFromEnv(env: NodeJS.ProcessEnv): AiEndpointPolicy {
  return parsePrivateTargets(env[PRIVATE_TARGETS_ENV]);
}

/** An IPv4-mapped IPv6 address is judged by its IPv4 address. */
function normalize(address: string, family: 4 | 6): { address: string; type: 'ipv4' | 'ipv6' } {
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return { address: mapped[1]!, type: 'ipv4' };
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const high = parseInt(hex[1]!, 16); const low = parseInt(hex[2]!, 16);
      return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, type: 'ipv4' };
    }
  }
  return { address, type: family === 6 ? 'ipv6' : 'ipv4' };
}

export type AddressClass = 'public' | 'private' | 'metadata';

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (!family) return 'private';
  const { address: value, type } = normalize(address, family as 4 | 6);
  if (metadata.check(value, type)) return 'metadata';
  return nonPublic.check(value, type) ? 'private' : 'public';
}

/** The reason an address may not be used for this request, or null. */
function addressRefusal(address: string, host: string, plainHttp: boolean, policy: AiEndpointPolicy): string | null {
  const kind = classifyAddress(address);
  if (kind === 'metadata') return 'it points at a cloud metadata address';
  const family = isIP(address);
  const { address: value, type } = family ? normalize(address, family as 4 | 6) : { address, type: 'ipv4' as const };
  const allowed = policy.hosts.has(host) || (family > 0 && policy.ranges.check(value, type));
  if (kind === 'private' && !allowed) return 'it reaches a private, loopback or link-local address that this server’s operator has not allowed';
  // Plain HTTP would expose the key in transit; it is only for the operator's own private network.
  if (plainHttp && !(kind === 'private' && allowed)) return 'plain http is allowed only for private targets this server’s operator allows; use https';
  return null;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** Synchronous checks that need no DNS: scheme, credentials, local names and IP literals. */
export function literalRefusal(url: URL, policy: AiEndpointPolicy): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'only https is allowed';
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const host = hostOf(url);
  if (!host) return 'the URL has no host';
  const plainHttp = url.protocol === 'http:';
  if (isIP(host)) return addressRefusal(host, host, plainHttp, policy);
  if ((host === 'localhost' || host.endsWith('.localhost')) && !policy.hosts.has(host))
    return 'it reaches a private, loopback or link-local address that this server’s operator has not allowed';
  return null;
}

export type Resolver = (host: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
});

/**
 * Whether `baseUrl` may be used now: null when allowed, otherwise a safe reason. Resolves the host
 * and checks every address it returns; any refused address refuses the whole URL.
 */
export async function checkEndpoint(baseUrl: string, policy: AiEndpointPolicy, resolve: Resolver = systemResolver): Promise<string | null> {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return 'the URL is not valid'; }
  const literal = literalRefusal(url, policy);
  const host = hostOf(url);
  if (literal || isIP(host)) return literal;
  let addresses: LookupAddress[];
  try { addresses = await resolve(host); } catch { return 'its host could not be resolved'; }
  if (!addresses.length) return 'its host could not be resolved';
  for (const entry of addresses) {
    const refusal = addressRefusal(entry.address, host, url.protocol === 'http:', policy);
    if (refusal) return refusal;
  }
  return null;
}

/** A refused endpoint: nothing was sent to it. */
export class EndpointRefusedError extends Error {
  readonly code = 'AI_ENDPOINT_REFUSED';
  constructor(readonly reason: string) {
    super(`The AI endpoint was refused: ${reason}`);
    this.name = 'EndpointRefusedError';
  }
}

/**
 * The socket lookup of one request: resolves the host when the connection is made and refuses it
 * unless every address passes the policy, so the checked address is the one connected to.
 */
export function guardedLookup(policy: AiEndpointPolicy, plainHttp: boolean, resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    resolve(host).then((addresses) => {
      const usable = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
      const refusal = !usable.length ? 'its host could not be resolved'
        : usable.map((entry) => addressRefusal(entry.address, host, plainHttp, policy)).find(Boolean) ?? null;
      if (refusal) return callback(new EndpointRefusedError(refusal), '', 0);
      if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    }, (error: NodeJS.ErrnoException) => callback(error, '', 0));
  };
}
