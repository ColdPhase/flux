import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `swapSafety()` (F-030 Memory): API and worker processes hold DEKs and plaintext in heap while unlocked, so a key may
 * be opened only where memory cannot be paged to a disk swap device. It passes when any of these holds:
 *  1. the process's own cgroup forbids swap (v2 `memory.swap.max` is `0`; v1 `memsw.limit` equals `limit`);
 *  2. `/proc/swaps` (the host's devices, also inside a container) lists none, or only `zram` devices;
 *  3. the operator set `FLUX_SWAP_ACKNOWLEDGED=encrypted-swap` (every swap device encrypted with a key not on disk).
 * A file that cannot be read fails its case (fail closed). The keyring (`apps/keyring/src/swap.ts`) applies the same
 * rule to itself; `tests/app/encryption-crypto.test.ts` checks that both agree on the same inputs.
 */
export type SwapVerdict =
  | { safe: true; via: 'cgroup' | 'no_swap' | 'acknowledged' }
  | { safe: false; reason: string };

/** Reads one file by its absolute path, or null when it is missing or unreadable. */
export type SwapFileReader = (path: string) => string | null;

/** The real files, optionally under a test root (`FLUX_TEST_SWAP_ROOT`, honoured only by test deployments). */
export function swapFiles(root = ''): SwapFileReader {
  return (path) => {
    try { return readFileSync(root ? join(root, path) : path, 'utf8'); } catch { return null; }
  };
}

export function swapSafety(env: Readonly<Record<string, string | undefined>>, read: SwapFileReader): SwapVerdict {
  const v2 = read('/sys/fs/cgroup/memory.swap.max')?.trim();
  if (v2 === '0') return { safe: true, via: 'cgroup' };
  const v1Limit = read('/sys/fs/cgroup/memory/memory.limit_in_bytes')?.trim();
  const v1Swap = read('/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes')?.trim();
  if (v1Limit && v1Swap && /^\d+$/.test(v1Limit) && v1Limit === v1Swap) return { safe: true, via: 'cgroup' };
  const swaps = read('/proc/swaps');
  if (swaps !== null) {
    const devices = swaps.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name): name is string => !!name);
    if (devices.every((name) => /^\/dev\/zram\d+$/.test(name))) return { safe: true, via: 'no_swap' };
  }
  if (env.FLUX_SWAP_ACKNOWLEDGED === 'encrypted-swap') return { safe: true, via: 'acknowledged' };
  return { safe: false, reason: 'This server can write memory to disk: swap is on and not limited for this process' };
}
