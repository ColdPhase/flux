// What the host must offer before the runtime serves anyone (RT-3, #860). A requirement that is not met stops the runtime with
// one clear message and the fix: it never serves, it never restarts itself, and its health check stays red, so `./flux up`
// and `docker compose up --wait` fail instead of reporting a healthy Flux.

/** The Linux capabilities the supervisor needs to give each person their own user id and to clean up after them, and no more. */
export const SUPERVISOR_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID'] as const;
const BITS: Record<(typeof SUPERVISOR_CAPABILITIES)[number], number> = { CHOWN: 0, DAC_OVERRIDE: 1, FOWNER: 3, KILL: 5, SETGID: 6, SETUID: 7 };

export interface HostFacts {
  /** `/proc/sys/kernel/yama/ptrace_scope`, or '' on a kernel without Yama. */
  ptraceScope: string;
  uid: number | null;
  /** `CapEff` of `/proc/self/status`, in hex. */
  effectiveCapabilities: string;
}

const YAMA_FIX = 'Fix: on the host run `sudo sysctl -w kernel.yama.ptrace_scope=1`, add `kernel.yama.ptrace_scope = 1` to /etc/sysctl.d/90-flux.conf '
  + 'so it survives a reboot, then run ./flux up again.';

/** The one message for the first requirement this host does not meet; null when it meets them all. */
export function hostProblem(facts: HostFacts): string | null {
  const scope = facts.ptraceScope.trim();
  if (!scope) return `The agent runtime needs Linux Yama, and this kernel has none (Docker Desktop is unsupported). Use a Linux host with kernel.yama.ptrace_scope=1.`;
  if (!/^[1-3]$/.test(scope)) return `The agent runtime needs kernel.yama.ptrace_scope of 1 or higher, and this host has ${scope}, so any process could read another's memory. ${YAMA_FIX}`;
  if (facts.uid !== 0) return 'The agent runtime needs its supervisor to start as root inside its container, to run each person under their own user id; this container starts as another user. Use the Compose files of this version without changing `user:`.';
  const effective = BigInt(`0x${/^[0-9a-f]{1,16}$/i.test(facts.effectiveCapabilities) ? facts.effectiveCapabilities : '0'}`);
  const missing = SUPERVISOR_CAPABILITIES.filter((name) => !(effective & (1n << BigInt(BITS[name]))));
  if (missing.length) return `The agent runtime needs the capabilities ${missing.join(', ')} inside its container to keep people apart. Use the Compose files of this version without changing \`cap_add:\`.`;
  return null;
}
