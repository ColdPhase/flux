import type { LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';

/** Host name to addresses; a rejection means the name does not resolve (or the resolver is busy). */
export type HostResolver = (host: string) => Promise<LookupAddress[]>;

/**
 * The resolver of link cards (#469). `dns.lookup` runs getaddrinfo on libuv's four-thread pool, which every other lookup of the
 * process shares (the database host, mail, sign-in, push): a few names that never answer would hold the pool well past the fetch's
 * own deadline and make everything else in the API wait. c-ares (`dns.promises.Resolver`) runs on its own sockets, takes no pool
 * thread, and gives up by itself: measured, a name server that never answers is given up on after about twice `timeoutMs` (it retries once), so
 * 750 ms keeps a lookup inside the fetch's 2 s connect budget. It asks the name servers only (no /etc/hosts, no search
 * domains), which is what a public name needs; the caller classifies every address it returns.
 * `maxPending` bounds the queries in flight (they outlive an aborted fetch by a bounded time).
 */
export function caresResolver(options: { servers?: string[]; timeoutMs?: number; maxPending?: number } = {}): HostResolver {
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 750, tries: 1 });
  if (options.servers) resolver.setServers(options.servers);
  const max = options.maxPending ?? 32;
  let pending = 0;
  return async (host) => {
    if (pending >= max) throw Object.assign(new Error(`EBUSY too many lookups in flight for ${host}`), { code: 'EBUSY' });
    pending++;
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
      const found: LookupAddress[] = [
        ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
        ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
      ];
      if (!found.length) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return found;
    } finally { pending--; }
  };
}
