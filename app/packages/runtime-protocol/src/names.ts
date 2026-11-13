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

/** `runtime-1` … `runtime-999`: the Compose service and network name of a slot. */
export const SLOT_NAME = /^runtime-[1-9][0-9]{0,2}$/;
/** A binding directory name: a canonical, lower-case version 4 UUID (also a database CHECK). */
export const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A supervisor process's boot id: a fresh version 4 UUID at every start. */
export const BOOT_ID = BINDING_ID;
/** Any canonical UUID (runs use the personal-run id). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * A model id a run may name (F-027 AST-11): the CLI's own alias or id (`sonnet`, `gpt-6.1-sol`). It starts with a
 * letter or digit, so it can never be read as a flag, and holds no space, quote or path character.
 */
export const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** A Flux MCP tool name, as the MCP route registers them (`flux_get_doc`). */
export const FLUX_TOOL_NAME = /^flux_[a-z][a-z0-9_]{0,62}$/;
/** A compact JWS (the per-run MCP token). Its content is never read by the runtime. */
export const RUN_TOKEN = /^[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{2,4096}$/;

/**
 * The engine of an API-key agent in the runtime (#1441, RT-1): pi, pinned in the runtime image. It needs no sign-in, so it is not a
 * `RuntimeClient` (those are the plan CLIs a person signs in to); a run names it as its engine.
 */
export const KEY_ENGINE = 'pi' as const;
export type KeyEngine = typeof KEY_ENGINE;
/** What a run may name as its engine: a plan's CLI, or pi for an API key. */
export const RUN_ENGINES = ['claude_code', 'codex', KEY_ENGINE] as const;
export type RunEngine = RuntimeClient | KeyEngine;
/** The providers of an API-key run (Flux's `AiProviderKind`, a closed list): pi speaks each one's wire format to Flux's model gateway. */
export const KEY_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
/**
 * A model id of an API-key run (#1441): what the key's provider lists, such as `claude-haiku-5-5`, `anthropic/claude-haiku-5.5`,
 * `google/gemini-3-flash:free` or `Qwen/Qwen3-32B`. It starts with a letter or digit, so it is never read as a flag, and holds no space,
 * quote or path character other than `/`. Pi takes it from its own models file, never from a command line.
 */
export const KEY_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export const isRuntimeClient = (value: unknown): value is RuntimeClient =>
  typeof value === 'string' && (RUNTIME_CLIENTS as readonly string[]).includes(value);

/** The words of a wrong `FLUX_AGENT_RUNTIME`, the same in every service that reads it. */
export const RUNTIME_SWITCH_HELP = 'FLUX_AGENT_RUNTIME must be empty or a comma-separated list of claude_code, codex and pi';

/**
 * `FLUX_AGENT_RUNTIME`: empty (off), or any of `claude_code`, `codex` and `pi`, comma-separated, each at most once (#1441: `pi` runs every
 * API-key agent in the runtime). Anything else is an operator error that stops the service at start.
 */
export function parseRuntimeEngines(value: string | undefined): { clients: RuntimeClient[]; pi: boolean } {
  const raw = (value ?? '').trim();
  if (!raw) return { clients: [], pi: false };
  const seen: string[] = [];
  for (const part of raw.split(',').map((item) => item.trim())) {
    if (!isRuntimeClient(part) && part !== KEY_ENGINE) throw new Error(`${RUNTIME_SWITCH_HELP} (got ${JSON.stringify(part.slice(0, 40))})`);
    if (seen.includes(part)) throw new Error(`FLUX_AGENT_RUNTIME names ${part} twice`);
    seen.push(part);
  }
  return { clients: RUNTIME_CLIENTS.filter((client) => seen.includes(client)), pi: seen.includes(KEY_ENGINE) };
}

/** The plan CLIs `FLUX_AGENT_RUNTIME` turns on (`pi` is accepted and is not one of them). */
export function parseRuntimeSwitch(value: string | undefined): RuntimeClient[] {
  return parseRuntimeEngines(value).clients;
}

/** Every runtime secret (slot secrets and the manager's service secret): 32 to 256 URL-safe characters. */
export const RUNTIME_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Fixed ports inside the runtime networks. */
export const RUNTIME_PORTS = { supervisor: 7700, manager: 7600, egressProxy: 3128, egressInstall: 3129, egressMcp: 8080 } as const;
