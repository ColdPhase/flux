import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The keyring's own swap check (F-030 Memory). It applies the same rule as `swapSafety()` in `@flux/core`
 * (`packages/core/src/encryption/swap.ts`); the keyring may import only Node built-ins, so the rule is repeated here and
 * `tests/app/encryption-keyring.test.ts` runs both over the same inputs. Passes when the cgroup forbids swap (v2
 * `memory.swap.max` = 0, v1 memsw = limit), when `/proc/swaps` lists no device but `zram`, or with
 * `FLUX_SWAP_ACKNOWLEDGED=encrypted-swap`. An unreadable file fails its case.
 */
export type SwapFileReader = (path: string) => string | null;

export function swapFiles(root = ''): SwapFileReader {
  return (path) => {
    try { return readFileSync(root ? join(root, path) : path, 'utf8'); } catch { return null; }
  };
}

/** TEST ONLY (`FLUX_TEST_SWAP_ROOT`): honoured only by a test deployment, the same rule as `testSwapRoot` in core. */
export function testDeployment(env: Readonly<Record<string, string | undefined>>): boolean {
  return !!env.FLUX_FIXTURE_TOKEN && env.FLUX_TEST_FAILURE_INJECTION === 'true';
}

export function swapSafe(env: Readonly<Record<string, string | undefined>>, read: SwapFileReader): boolean {
  if (read('/sys/fs/cgroup/memory.swap.max')?.trim() === '0') return true;
  const limit = read('/sys/fs/cgroup/memory/memory.limit_in_bytes')?.trim();
  const memsw = read('/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes')?.trim();
  // A real v1 limit: below 2^62 ("no limit" is a page-rounded 2^63 - 1, and two of those are equal without forbidding swap).
  if (limit && memsw && /^\d{1,19}$/.test(limit) && BigInt(limit) < 1n << 62n && limit === memsw) return true;
  const swaps = read('/proc/swaps');
  if (swaps !== null && swaps.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean)
    .every((name) => /^\/dev\/zram\d+$/.test(name!))) return true;
  return env.FLUX_SWAP_ACKNOWLEDGED === 'encrypted-swap';
}
