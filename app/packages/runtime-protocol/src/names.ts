// Names shared by the API, worker, manager, supervisor and egress of the `runtime` transport
// (F-022 AIM-3). Each is a closed list or a fixed pattern; none comes from a person's input.

export const RUNTIME_CLIENTS = ['claude_code', 'codex'] as const;
export type RuntimeClient = (typeof RUNTIME_CLIENTS)[number];

/** Every method of each CLI's own login command (F-022 "Sign-in as in a terminal"). */
export const RUNTIME_LOGIN_METHODS = {
  claude_code: ['claude_account', 'console', 'sso'],
  codex: ['device_code', 'api_key', 'access_token'],
} as const satisfies Record<RuntimeClient, readonly string[]>;
export type RuntimeLoginMethod = (typeof RUNTIME_LOGIN_METHODS)[RuntimeClient][number];
export const ALL_LOGIN_METHODS = [...RUNTIME_LOGIN_METHODS.claude_code, ...RUNTIME_LOGIN_METHODS.codex] as const;

/** `runtime-1` … `runtime-999`: the Compose service and network name of a slot. */
export const SLOT_NAME = /^runtime-[1-9][0-9]{0,2}$/;
/** A binding directory name: a canonical, lower-case version 4 UUID (also a database CHECK). */
export const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A supervisor process's boot id: a fresh version 4 UUID at every start. */
export const BOOT_ID = BINDING_ID;
/** Any canonical UUID (runs use the personal-run id). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A Flux MCP tool name, as the MCP route registers them (`flux_get_doc`). */
export const FLUX_TOOL_NAME = /^flux_[a-z][a-z0-9_]{0,62}$/;
/** A compact JWS (the per-run MCP token). Its content is never read by the runtime. */
export const RUN_TOKEN = /^[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{2,4096}$/;

export const isRuntimeClient = (value: unknown): value is RuntimeClient =>
  typeof value === 'string' && (RUNTIME_CLIENTS as readonly string[]).includes(value);

/**
 * `FLUX_AGENT_RUNTIME`: empty (off), `claude_code`, `codex` or both, comma-separated, each at most
 * once. Anything else is an operator error that stops the service at start.
 */
export function parseRuntimeSwitch(value: string | undefined): RuntimeClient[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(',').map((part) => part.trim());
  const clients: RuntimeClient[] = [];
  for (const part of parts) {
    if (!isRuntimeClient(part)) throw new Error(`FLUX_AGENT_RUNTIME must be empty, claude_code, codex or claude_code,codex (got ${JSON.stringify(part.slice(0, 40))})`);
    if (clients.includes(part)) throw new Error(`FLUX_AGENT_RUNTIME names ${part} twice`);
    clients.push(part);
  }
  return RUNTIME_CLIENTS.filter((client) => clients.includes(client));
}

/** The minimum length of every runtime secret (slot secrets and the manager's service secret). */
export const RUNTIME_SECRET_MIN_LENGTH = 32;
export const RUNTIME_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Fixed ports inside the runtime networks. */
export const RUNTIME_PORTS = { supervisor: 7700, manager: 7600, egressProxy: 3128, egressInstall: 3129, egressMcp: 8080 } as const;
