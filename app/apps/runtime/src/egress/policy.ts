import { isIP } from 'node:net';
import { RUNTIME_CLIENTS, type RuntimeClient } from '@flux/runtime-protocol';

// `runtime-egress` policy (F-022 "Network"). A slot reaches the internet only through CONNECT to the
// hosts its CLI documents, on port 443, and Flux only through the exact `/mcp` route. These parsers
// see bytes a compromised slot controls, so they are small, strict and fuzz-tested.

/** Claude Code's documented hosts (research 2026-10-05 §2.1). Codex's are recorded from its pinned source in T6. */
export const VENDOR_HOSTS: Record<RuntimeClient, readonly string[]> = {
  claude_code: ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com'],
  codex: [],
};
/** Only the one-shot `runtime-install` reaches the installer's download host, on its own network. */
export const INSTALL_HOSTS: readonly string[] = ['downloads.claude.ai'];

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TARGET = new RegExp(`^(${LABEL}(?:\\.${LABEL})+):443$`);

/** `host:443` with a lower-case DNS name of at least two labels; no IP literal, user info or other port. */
export function parseConnectTarget(target: unknown): { host: string; port: 443 } | null {
  if (typeof target !== 'string' || target.length > 260) return null;
  const match = TARGET.exec(target);
  if (!match) return null;
  const host = match[1]!;
  if (host.length > 253 || isIP(host) || /^[0-9.]+$/.test(host)) return null;
  return { host, port: 443 };
}

export function allowedHosts(clients: readonly RuntimeClient[], options: { includeSignOut?: boolean } = {}): Set<string> {
  // TLS hides the request path: cleanup needs the recorded vendor hosts even after the
  // operator switches clients off. The supervisor still refuses login/status/run then.
  return new Set((options.includeSignOut ? RUNTIME_CLIENTS : clients).flatMap((client) => VENDOR_HOSTS[client]));
}

/** The one Flux route a slot may use: exactly `/mcp`, with the methods of MCP's HTTP transport. */
export function isMcpRequest(method: unknown, url: unknown): boolean {
  return (method === 'POST' || method === 'GET' || method === 'DELETE') && url === '/mcp';
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN));
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

function publicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;            // this net, private, loopback, multicast, reserved
  if (a === 100 && b! >= 64 && b! <= 127) return false;                      // CGNAT
  if (a === 169 && b === 254) return false;                                 // link-local, cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false;                       // private
  if (a === 192 && b === 168) return false;                                 // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;           // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;                      // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false;                    // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                     // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;                      // TEST-NET-3
  return true;
}

/** Whether a resolved address is on the public internet (not the LAN, loopback, metadata or reserved). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = ipv4Parts(address);
    return parts !== null && publicIpv4(parts);
  }
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (lower === '::' || lower === '::1') return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false;                            // unique local
  if ((first & 0xffc0) === 0xfe80) return false;                            // link-local
  if ((first & 0xff00) === 0xff00) return false;                            // multicast
  if (lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8:') || lower.startsWith('2002:') || lower.startsWith('::')) return false;
  return (first & 0xe000) === 0x2000;                                        // global unicast only
}
