// How many agents can run on this server at once (#860, RT-3). Each run holds one CLI: what it may use is the sizing below, and
// what is left of the runtime's memory after the supervisor decides how many fit: about 2 on a 4 GB server. The worker holds the
// others back with "Waiting for room on the server". An idle person costs nothing but their directory: no process.

/** The memory one active agent is planned for (docs/operations/agent-runtime.md "What each agent needs"). */
export const RUN_MEMORY_BYTES = 1024 ** 3;
/** The supervisor, its Node runtime and the small commands (status, sign-out) it runs in between. */
export const SUPERVISOR_MEMORY_BYTES = 256 * 1024 ** 2;
/** What `FLUX_RUNTIME_MAX_RUNS` may say. */
export const MAX_RUNS = 9999;

/** `limit`: the memory this container may use (its cgroup limit), or the machine's when it has none. */
export function capacityFromMemory(limitBytes: number): number {
  return Math.min(MAX_RUNS, Math.max(1, Math.floor((limitBytes - SUPERVISOR_MEMORY_BYTES) / RUN_MEMORY_BYTES)));
}

/** The operator's number when there is one, otherwise what fits. A wrong value throws: the caller refuses to start. */
export function runCapacity(configured: string | undefined, limitBytes: number): number {
  const value = (configured ?? '').trim();
  if (!value) return capacityFromMemory(limitBytes);
  if (!/^[1-9][0-9]{0,3}$/.test(value)) throw new Error(`FLUX_RUNTIME_MAX_RUNS must be empty (worked out from memory) or a number from 1 to ${MAX_RUNS}`);
  return Number(value);
}
