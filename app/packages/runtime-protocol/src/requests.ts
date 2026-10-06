import { BINDING_ID, FLUX_TOOL_NAME, RUN_TOKEN, RUNTIME_CLIENTS, RUNTIME_LOGIN_METHODS, UUID, type RuntimeClient, type RuntimeLoginMethod } from './names.js';
import { arrayOf, firstBadKey, int, object, oneOf, str, text, type Check } from './shape.js';

// The supervisor's closed request set (F-022 "Runtime slots and the supervisor"). Each request names
// a client and a method from fixed lists and carries only data. No request field is a command line, a
// flag, a path or an environment value: the supervisor builds every command from a fixed template.

export const SUPERVISOR_REQUESTS = ['bind', 'login', 'status', 'run', 'stop', 'logout', 'release'] as const;
export type SupervisorRequestKind = (typeof SUPERVISOR_REQUESTS)[number];

export const REQUEST_LIMITS = {
  /** The largest JSON body any supervisor or manager request may have. */
  bodyBytes: 64 * 1024,
  /** A run's prompt, sent to the CLI on stdin. */
  promptCharacters: 32 * 1024,
  /** Exact Flux MCP tool names per run. */
  tools: 32,
} as const;

/** Caps a run request carries (F-022 "Caps"); the owner may lower the defaults. */
export const RUN_CAP_BOUNDS = {
  maxTurns: { min: 1, max: 50 },
  wallClockSeconds: { min: 10, max: 1800 },
  idleSeconds: { min: 5, max: 600 },
  maxAnswerBytes: { min: 1024, max: 64 * 1024 },
} as const;

export interface RunCaps { maxTurns: number; wallClockSeconds: number; idleSeconds: number; maxAnswerBytes: number }

export type SupervisorRequest =
  | { kind: 'bind'; bindingId: string }
  | { kind: 'status'; bindingId?: string; client?: RuntimeClient }
  | { kind: 'login'; bindingId: string; client: RuntimeClient; method: RuntimeLoginMethod }
  | { kind: 'run'; bindingId: string; client: RuntimeClient; runId: string; prompt: string; runToken: string; tools: string[]; caps: RunCaps }
  | { kind: 'stop'; bindingId: string; runId: string }
  | { kind: 'logout'; bindingId: string; client: RuntimeClient }
  | { kind: 'release'; bindingId: string };

const bindingId = str(BINDING_ID, 36);
const client = oneOf(RUNTIME_CLIENTS);
const caps = object({
  maxTurns: int(RUN_CAP_BOUNDS.maxTurns.min, RUN_CAP_BOUNDS.maxTurns.max),
  wallClockSeconds: int(RUN_CAP_BOUNDS.wallClockSeconds.min, RUN_CAP_BOUNDS.wallClockSeconds.max),
  idleSeconds: int(RUN_CAP_BOUNDS.idleSeconds.min, RUN_CAP_BOUNDS.idleSeconds.max),
  maxAnswerBytes: int(RUN_CAP_BOUNDS.maxAnswerBytes.min, RUN_CAP_BOUNDS.maxAnswerBytes.max),
});
const uniqueTools: Check<string[]> = (value): value is string[] =>
  arrayOf(str(FLUX_TOOL_NAME, 67), REQUEST_LIMITS.tools, 1)(value) && new Set(value).size === value.length;

type Fields = { required: Record<string, Check<unknown>>; optional?: Record<string, Check<unknown>> };
const SHAPES: Record<SupervisorRequestKind, Fields> = {
  bind: { required: { bindingId } },
  status: { required: {}, optional: { bindingId, client } },
  login: { required: { bindingId, client, method: oneOf([...RUNTIME_LOGIN_METHODS.claude_code, ...RUNTIME_LOGIN_METHODS.codex]) } },
  run: { required: { bindingId, client, runId: str(UUID, 36), prompt: text(REQUEST_LIMITS.promptCharacters, 1), runToken: str(RUN_TOKEN, 12_300), tools: uniqueTools, caps } },
  stop: { required: { bindingId, runId: str(UUID, 36) } },
  logout: { required: { bindingId, client } },
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
  if (kind === 'login' && !(RUNTIME_LOGIN_METHODS[fields.client as RuntimeClient] as readonly string[]).includes(fields.method as string)) {
    return { ok: false, code: 'invalid_request', field: 'method' };
  }
  return { ok: true, request: { kind, ...fields } as SupervisorRequest };
}

/** The wire body of a request (its fields without `kind`, which travels in the path). */
export function requestBody(request: SupervisorRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...request };
  delete fields.kind;
  return fields;
}
