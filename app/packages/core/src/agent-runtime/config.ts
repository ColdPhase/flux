import { AGENT_RUNTIME_CLIENTS, type AgentRuntimeClient, type AgentRuntimeClientAvailability } from '@flux/contracts';

// The operator's settings of the `runtime` transport (F-022 "Operator switch and installation"), read
// once by the API and the worker. Empty FLUX_AGENT_RUNTIME (the default) is off: no runtime service
// runs and nothing here reaches the manager. A wrong value stops the service at start.

export interface AgentRuntimeConfig {
  clients: AgentRuntimeClient[];
  /** FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS: the date the operator agreed to Anthropic's Commercial Terms. */
  commercialTermsAgreedOn: string | null;
  /** FLUX_AGENT_RUNTIME_IDLE_DAYS: release a binding after this many days without a run; null is off. */
  idleDays: number | null;
  manager: { url: string; secret: string } | null;
}

/** Codex stays off in this version until its hosts and checks are recorded (F-022 T6). */
export const RUNTIME_CLIENTS_SUPPORTED: Record<AgentRuntimeClient, boolean> = { claude_code: true, codex: false };

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseAgentRuntimeClients(value: string | undefined): AgentRuntimeClient[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];
  const clients: AgentRuntimeClient[] = [];
  for (const part of raw.split(',').map((item) => item.trim())) {
    if (!(AGENT_RUNTIME_CLIENTS as readonly string[]).includes(part)) {
      throw new Error(`FLUX_AGENT_RUNTIME must be empty, claude_code, codex or claude_code,codex (got ${JSON.stringify(part.slice(0, 40))})`);
    }
    if (clients.includes(part as AgentRuntimeClient)) throw new Error(`FLUX_AGENT_RUNTIME names ${part} twice`);
    clients.push(part as AgentRuntimeClient);
  }
  return AGENT_RUNTIME_CLIENTS.filter((client) => clients.includes(client));
}

export function loadAgentRuntimeConfig(env: NodeJS.ProcessEnv, today = new Date()): AgentRuntimeConfig {
  const clients = parseAgentRuntimeClients(env.FLUX_AGENT_RUNTIME);
  const idleRaw = (env.FLUX_AGENT_RUNTIME_IDLE_DAYS ?? '').trim();
  if (idleRaw && !/^[1-9][0-9]{0,2}$/.test(idleRaw)) throw new Error('FLUX_AGENT_RUNTIME_IDLE_DAYS must be empty (off) or a number of days from 1 to 365');
  const idleDays = idleRaw ? Number(idleRaw) : null;
  if (idleDays !== null && idleDays > 365) throw new Error('FLUX_AGENT_RUNTIME_IDLE_DAYS must be at most 365');
  if (!clients.length) return { clients, commercialTermsAgreedOn: null, idleDays, manager: null };
  const secret = env.FLUX_RUNTIME_MANAGER_SECRET ?? '';
  if (!SECRET.test(secret)) throw new Error('FLUX_AGENT_RUNTIME is on, but FLUX_RUNTIME_MANAGER_SECRET is missing or shorter than 32 characters (./flux generates it in docker/.env)');
  let commercialTermsAgreedOn: string | null = null;
  if (clients.includes('claude_code')) {
    const stated = (env.FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS ?? '').trim();
    const match = DATE.exec(stated);
    const parsed = match ? new Date(`${stated}T00:00:00Z`) : null;
    if (!match || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stated) {
      throw new Error('FLUX_AGENT_RUNTIME=claude_code needs FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=<YYYY-MM-DD>: the date you agreed to Anthropic\'s Commercial Terms with Anthropic (see docs/operations/agent-runtime.md)');
    }
    if (parsed.getTime() > today.getTime() + 36 * 3600_000) throw new Error('FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS is a date in the future');
    if (stated < '2023-01-01') throw new Error('FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS is before 2023-01-01');
    commercialTermsAgreedOn = stated;
  }
  const url = (env.FLUX_RUNTIME_MANAGER_URL ?? 'http://runtime-manager-control:7600').trim();
  if (!/^http:\/\/[a-z0-9.-]+:[0-9]{1,5}$/.test(url)) throw new Error('FLUX_RUNTIME_MANAGER_URL must be http://<host>:<port>');
  return { clients, commercialTermsAgreedOn, idleDays, manager: { url, secret } };
}

export function clientAvailability(config: AgentRuntimeConfig): Record<AgentRuntimeClient, AgentRuntimeClientAvailability> {
  const state = (client: AgentRuntimeClient): AgentRuntimeClientAvailability =>
    !config.clients.includes(client) ? 'off' : RUNTIME_CLIENTS_SUPPORTED[client] ? 'available' : 'pending';
  return { claude_code: state('claude_code'), codex: state('codex') };
}
