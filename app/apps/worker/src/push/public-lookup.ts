import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, type LookupFunction } from 'node:net';

const PRIVATE_RANGES: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['64:ff9b::', 96, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
];
const privateAddresses = new BlockList();
for (const [address, prefix, family] of PRIVATE_RANGES) privateAddresses.addSubnet(address, prefix, family);

// Node applies IPv4 rules to mapped IPv6 forms too. Blocking all ::ffff/96 would
// therefore block all IPv4, including ordinary public push-service answers.
export type PublicLookupResolver = (hostname: string, options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** Reject the entire DNS answer set at connection time if any destination is denied. */
export function createPublicOnlyLookup(resolve: PublicLookupResolver = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, list) => {
      if (error) return callback(error, '', 0);
      const blocked = list.find((entry) => privateAddresses.check(entry.address, entry.family === 6 ? 'ipv6' : 'ipv4'));
      if (!list.length || blocked) {
        const refused = Object.assign(new Error(`Push endpoint ${hostname} resolves to a non-public address`), { code: 'EPUSHPRIVATE' });
        return callback(refused, '', 0);
      }
      if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}
