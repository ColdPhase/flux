import {
  BINDING_ID, FLUX_TOOL_NAME, KEY_ENGINE, KEY_MODEL_ID, KEY_PROVIDERS, MODEL_ID, RUN_ENGINES, RUN_TOKEN, RUNTIME_CLIENTS, RUNTIME_LOGIN_METHODS, UUID,
  type KeyProvider, type RuntimeClient, type RuntimeLoginMethod,
} from './names.js';
import { MODEL_GATEWAY_TOKEN } from './model-gateway.js';
import { arrayOf, firstBadKey, int, object, oneOf, str, text, type Check } from './shape.js';

/** The terminal size a sign-in console may ask for (F-022 T4): a phone held upright to a wide screen. */
export const CONSOLE_SIZE = { cols: { min: 20, max: 300 }, rows: { min: 5, max: 120 } } as const;

// The supervisor's closed request set (F-022 "Runtime slots and the supervisor"). Each request names
// a client and a method from fixed lists and carries only data. No request field is a command line, a
// flag, a path or an environment value: the supervisor builds every command from a fixed template.

export const SUPERVISOR_REQUESTS = ['bind', 'login', 'status', 'models', 'run', 'stop', 'logout', 'release'] as const;
export type SupervisorRequestKind = (typeof SUPERVISOR_REQUESTS)[number];

export const REQUEST_LIMITS = {
  /** The largest JSON body any supervisor or manager request may have. */
  bodyBytes: 64 * 1024,
  /** A run's prompt, sent to the CLI on stdin. */
  promptCharacters: 32 * 1024,
  /** Exact Flux MCP tool names per run: the reads and, since F-027 A3, the change tools (34 with every switch on). */
  tools: 64,
} as const;

/**
 * The technical safety bounds a run request carries (#843: Flux sets no limits of its own; these only stop a run that went
 * wrong). The supervisor refuses values outside them.
 */
export const RUN_CAP_BOUNDS = {
  maxTurns: { min: 1, max: 500 },
  wallClockSeconds: { min: 10, max: 7200 },
  idleSeconds: { min: 5, max: 1800 },
  maxAnswerBytes: { min: 1024, max: 64 * 1024 },
} as const;

export interface RunCaps { maxTurns: number; wallClockSeconds: number; idleSeconds: number; maxAnswerBytes: number }

export type SupervisorRequest =
  | { kind: 'bind'; bindingId: string }
  | { kind: 'status'; bindingId?: string; client?: RuntimeClient; bootId?: string }
  /**
   * The models the signed-in CLI itself offers (#1332, F-022 amended): Claude Code's initialization answer, Codex's `model/list`. Read-only,
   * and it never waits behind the person's other work: the supervisor answers `busy` when their lane is taken.
   */
  | { kind: 'models'; bindingId: string; bootId: string; client: RuntimeClient }
  /** Only through the sign-in console (console.ts): the supervisor runs the method's fixed command in a PTY. */
  | { kind: 'login'; bindingId: string; bootId: string; client: RuntimeClient; method: RuntimeLoginMethod; cols: number; rows: number }
  /**
   * `model`: the assistant's chosen model (F-027 AST-11), passed to the CLI's own model option; absent: the account's default.
   * `webSearch`: the CLI keeps its own web search (#1065, C-29: the operator's web switch is on): Claude Code's `WebSearch`, Codex's
   * web search on OpenAI's cached index (`web_search="cached"`).
   */
  | { kind: 'run'; bindingId: string; client: RuntimeClient; runId: string; prompt: string; runToken: string; tools: string[]; caps: RunCaps; model?: string; webSearch?: true }
  /**
   * An API-key agent's run in pi (#1441, RT-1): the key's `provider` and `model` (required; pi has no account default). The key itself never
   * comes here: pi reaches Flux's model gateway through the egress with the run token, and the gateway holds the key and meters each request.
   * `pictures`: the model takes image input (Flux's table for the provider and model).
   */
  | { kind: 'run'; bindingId: string; client: typeof KEY_ENGINE; runId: string; prompt: string; runToken: string; tools: string[]; caps: RunCaps; model: string;
    provider: KeyProvider; modelToken: string; pictures?: true; webSearch?: true }
  | { kind: 'stop'; bindingId: string; runId: string }
  | { kind: 'logout'; bindingId: string; bootId: string; client: RuntimeClient }
  | { kind: 'release'; bindingId: string };

const bindingId = str(BINDING_ID, 36);
const client = oneOf(RUNTIME_CLIENTS);
const engine = oneOf(RUN_ENGINES);
const caps = object({
  maxTurns: int(RUN_CAP_BOUNDS.maxTurns.min, RUN_CAP_BOUNDS.maxTurns.max),
  wallClockSeconds: int(RUN_CAP_BOUNDS.wallClockSeconds.min, RUN_CAP_BOUNDS.wallClockSeconds.max),
  idleSeconds: int(RUN_CAP_BOUNDS.idleSeconds.min, RUN_CAP_BOUNDS.idleSeconds.max),
  maxAnswerBytes: int(RUN_CAP_BOUNDS.maxAnswerBytes.min, RUN_CAP_BOUNDS.maxAnswerBytes.max),
});
const uniqueTools: Check<string[]> = (value): value is string[] =>
  arrayOf(str(FLUX_TOOL_NAME, 67), REQUEST_LIMITS.tools, 1)(value) && new Set(value).size === value.length;

const yes = (value: unknown): value is true => value === true;

type Fields = { required: Record<string, Check<unknown>>; optional?: Record<string, Check<unknown>> };
const SHAPES: Record<SupervisorRequestKind, Fields> = {
  bind: { required: { bindingId } },
  status: { required: {}, optional: { bindingId, client, bootId: str(UUID, 36) } },
  models: { required: { bindingId, bootId: str(UUID, 36), client } },
  login: { required: { bindingId, bootId: str(UUID, 36), client, method: oneOf([...RUNTIME_LOGIN_METHODS.claude_code, ...RUNTIME_LOGIN_METHODS.codex]),
    cols: int(CONSOLE_SIZE.cols.min, CONSOLE_SIZE.cols.max), rows: int(CONSOLE_SIZE.rows.min, CONSOLE_SIZE.rows.max) } },
  run: { required: { bindingId, client: engine, runId: str(UUID, 36), prompt: text(REQUEST_LIMITS.promptCharacters, 1), runToken: str(RUN_TOKEN, 12_300), tools: uniqueTools, caps },
    optional: { model: str(KEY_MODEL_ID, 128), webSearch: yes, provider: oneOf(KEY_PROVIDERS), pictures: yes, modelToken: str(MODEL_GATEWAY_TOKEN, 51) } },
  stop: { required: { bindingId, runId: str(UUID, 36) } },
  logout: { required: { bindingId, bootId: str(UUID, 36), client } },
  release: { required: { bindingId } },
};

export const isSupervisorRequestKind = (value: unknown): value is SupervisorRequestKind =>
  typeof value === 'string' && (SUPERVISOR_REQUESTS as readonly string[]).includes(value);

export type ParsedRequest =
  | { ok: true; request: SupervisorRequest }
  | { ok: false; code: 'unknown_request' | 'invalid_request'; field?: string };

/**
 * Checks a request body against the closed set. Unknown kinds, unknown or extra keys, wrong types and
 * out-of-range values are refused; nothing is coerced or defaulted. A `status` that names a client
 * must also name the binding, and a login method must belong to the named client.
 */
export function parseSupervisorRequest(kind: unknown, body: unknown): ParsedRequest {
  if (!isSupervisorRequestKind(kind)) return { ok: false, code: 'unknown_request' };
  const { required, optional = {} } = SHAPES[kind];
  const bad = firstBadKey(body, required, optional);
  if (bad !== undefined) return { ok: false, code: 'invalid_request', field: bad };
  const fields = body as Record<string, unknown>;
  if (kind === 'status' && fields.client !== undefined && fields.bindingId === undefined) return { ok: false, code: 'invalid_request', field: 'bindingId' };
  if (kind === 'status' && fields.client !== undefined && fields.bootId === undefined) return { ok: false, code: 'invalid_request', field: 'bootId' };
  if (kind === 'run') {
    // A plan CLI takes the narrower `MODEL_ID` and no key fields; pi (#1441) needs its key's provider and model.
    const pi = fields.client === KEY_ENGINE;
    if (pi && fields.model === undefined) return { ok: false, code: 'invalid_request', field: 'model' };
    if (!pi && fields.model !== undefined && !MODEL_ID.test(fields.model as string)) return { ok: false, code: 'invalid_request', field: 'model' };
    if (pi !== (fields.provider !== undefined)) return { ok: false, code: 'invalid_request', field: 'provider' };
    // Its model gateway token (#1441): pi's API key, which only Flux's gateway takes.
    if (pi !== (fields.modelToken !== undefined)) return { ok: false, code: 'invalid_request', field: 'modelToken' };
    if (!pi && fields.pictures !== undefined) return { ok: false, code: 'invalid_request', field: 'pictures' };
  }
  if (kind === 'login' && !(RUNTIME_LOGIN_METHODS[fields.client as RuntimeClient] as readonly string[]).includes(fields.method as string)) {
    return { ok: false, code: 'invalid_request', field: 'method' };
  }
  return { ok: true, request: { kind, ...fields } as unknown as SupervisorRequest };
}

/** The wire body of a request (its fields without `kind`, which travels in the path). */
export function requestBody(request: SupervisorRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...request };
  delete fields.kind;
  return fields;
}
