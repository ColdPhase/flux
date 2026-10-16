import { BINDING_ID, BOOT_ID, FLUX_TOOL_NAME, RUNTIME_CLIENTS, SLOT_NAME, UUID, type RuntimeClient } from './names.js';
import { RUN_CAP_BOUNDS, SUPERVISOR_REQUESTS, type SupervisorRequestKind } from './requests.js';
import { arrayOf, bool, int, isPlainObject, literal, object, oneOf, str, text, type Check } from './shape.js';

// What a supervisor answers: a stream of newline-delimited JSON frames. The manager reads it with the
// bounded reader in ndjson.ts and checks every frame against these closed shapes, because this stream
// is where a compromised slot would try to reach the manager (F-022 "Network").

export const SUPERVISOR_ERRORS = [
  'unauthorized', 'unknown_request', 'invalid_request', 'busy', 'client_off', 'not_installed',
  'data_not_empty', 'no_binding', 'binding_mismatch', 'binding_unsafe', 'binding_too_large',
  'not_available', 'internal',
] as const;
export type SupervisorError = (typeof SUPERVISOR_ERRORS)[number];

export const STEP_OUTCOMES = ['ok', 'failed', 'timeout', 'not_installed', 'skipped'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** The most binding directories a slot report lists; a supervisor never holds more than one. */
export const MAX_REPORTED_BINDINGS = 8;

export interface SlotReport {
  slot: string;
  bootId: string;
  /** `/data`: binding directories (UUID names that are real directories) and any other entries. */
  data: { empty: boolean; bindings: string[]; other: number };
  /** True while `/tmp` holds no entry; a new process after a release starts with an empty tmpfs. */
  tmpEmpty: boolean;
  /** Which CLIs are present (Claude Code from the tools volume, Codex in the image). */
  installed: Record<RuntimeClient, boolean>;
  /** The operator's `FLUX_AGENT_RUNTIME` as the slot reads it. */
  enabled: RuntimeClient[];
  busy: boolean;
}

/**
 * What a CLI's own status command reports, reduced in the slot to display facts (F-022 "Sign-in as in a
 * terminal", step 5): the authentication method, the plan if reported, a masked account label and a
 * digest of the account's identity for the account-change notice. Never the address itself, never a
 * credential.
 */
export interface ClientFacts {
  /** `claude auth status`'s `authMethod` (`claude.ai`, `api_key`, …), or `unknown`. */
  authMethod: string;
  plan: string | null;
  /** `a***@example.org`: the first character of the address and its domain. */
  accountLabel: string | null;
  /** SHA-256 (hex) of the account's address and organization; compared, never shown. */
  accountDigest: string | null;
}

export const AUTH_METHOD = /^[a-z][a-z0-9_.-]{0,31}$/;
export const PLAN_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;
export const ACCOUNT_LABEL = /^[A-Za-z0-9*]\*\*\*@[A-Za-z0-9.*-]{1,70}$/;
export const ACCOUNT_DIGEST = /^[0-9a-f]{64}$/;

export interface ClientStatus {
  client: RuntimeClient;
  signedIn: boolean;
  /** Only when signed in and the CLI reported them. */
  facts: ClientFacts | null;
  /** Checked by `stat` only, never read: present with mode 0600, missing, or too open. */
  credentialFile: 'ok' | 'missing' | 'loose_mode';
  bindingBytes: number;
  bindingOverLimit: boolean;
}

/**
 * How a run ended in the slot (F-022 T5: each end has its own state). `completed`: the CLI's result is the
 * answer. `local_tool`: its start-up tool list named anything but the run's exact Flux tools or a connected
 * Flux server, and it was stopped. `unknown`: its stream broke; nothing is known about what it did.
 */
export const RUN_OUTCOMES = [
  'completed', 'stopped', 'local_tool', 'sign_in_again', 'plan_limit', 'max_turns', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'unknown', 'refused',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** A name in the CLI's start-up list (a tool, or an MCP server), reduced by the slot; never its arguments. */
export const INIT_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** What a run reports while it runs: the CLI's start-up lists, then each Flux tool it calls. */
export type RunFrame =
  | { t: 'run'; e: 'init'; tools: string[]; servers: { name: string; status: string }[] }
  | { t: 'run'; e: 'tool'; name: string };

export type SupervisorResult =
  | { kind: 'bind'; bindingId: string }
  /** The CLI's answer (at most the run's answer size) only when `completed`. */
  | { kind: 'run'; runId: string; outcome: RunOutcome; answer: string | null; resetsAt: string | null; turns: number }
  | { kind: 'status'; slot: SlotReport }
  | { kind: 'status'; client: ClientStatus }
  | { kind: 'logout'; client: RuntimeClient; logout: StepOutcome }
  | { kind: 'release'; bindingId: string; logout: Record<RuntimeClient, StepOutcome>; dataEmpty: boolean; exiting: boolean }
  | { kind: 'stop'; runId: string; state: 'not_running' | 'stopping' }
  /** The sign-in console ended: the CLI exited or reached the console's lifetime; then its status. */
  | { kind: 'login'; client: RuntimeClient; ended: 'exited' | 'timed_out'; exitCode: number | null; status: ClientStatus };

/**
 * The one exception to "nothing parses console output" (F-027 AST-1, A12; #281): during `codex login
 * --device-auth` the slot recognises the verification URL and the one-time code in the CLI's output, in
 * memory, so the sign-in card can draw them; and the two failures Journey 6 names. Never stored or logged.
 */
export const DEVICE_URL = /^https:\/\/auth\.openai\.com\/codex\/device$/;
export const DEVICE_CODE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;
/** Claude Code's sign-in page (`claude auth login`): only Anthropic's own https hosts, one URL of a few hundred characters. */
export const CLAUDE_SIGN_IN_URL = /^https:\/\/(?:claude\.com|platform\.claude\.com|claude\.ai)\/[\w./-]{1,64}\?[\w%.~+=&:-]{1,1500}$/;
export const SIGN_IN_PROBLEMS = ['device_auth_disabled', 'code_expired'] as const;
export type SignInProblem = (typeof SIGN_IN_PROBLEMS)[number];
export type SignInFrame =
  | { t: 'signin'; e: 'device'; url: string; code: string }
  | { t: 'signin'; e: 'url'; url: string }
  | { t: 'signin'; e: 'problem'; problem: SignInProblem };

export type SupervisorFrame =
  | { t: 'accepted'; kind: SupervisorRequestKind; bootId: string }
  | SignInFrame
  | { t: 'step'; step: 'logout' | 'delete' | 'verify'; outcome: StepOutcome; client?: RuntimeClient }
  | { t: 'result'; result: SupervisorResult }
  /** Sign-in console only: the PTY started, or its command ended (by exiting or after the lifetime). */
  | { t: 'console'; state: 'started' | 'exited' | 'timed_out' }
  | RunFrame
  | { t: 'error'; code: SupervisorError };

const client = oneOf(RUNTIME_CLIENTS);
const outcome = oneOf(STEP_OUTCOMES);
const perClient = <T>(check: Check<T>) => object({ claude_code: check, codex: check }) as unknown as Check<Record<RuntimeClient, T>>;
const enabled: Check<RuntimeClient[]> = (value): value is RuntimeClient[] =>
  arrayOf(client, 2)(value) && new Set(value).size === value.length;

export const isSlotReport: Check<SlotReport> = object({
  slot: str(SLOT_NAME, 12),
  bootId: str(BOOT_ID, 36),
  data: object({ empty: bool, bindings: arrayOf(str(BINDING_ID, 36), MAX_REPORTED_BINDINGS), other: int(0, 1_000_000) }),
  tmpEmpty: bool,
  installed: perClient(bool),
  enabled,
  busy: bool,
}) as unknown as Check<SlotReport>;

const nullable = <T>(check: Check<T>): Check<T | null> => (value): value is T | null => value === null || check(value);
const isClientFacts = object({
  authMethod: str(AUTH_METHOD, 32), plan: nullable(str(PLAN_LABEL, 40)), accountLabel: nullable(str(ACCOUNT_LABEL, 80)), accountDigest: nullable(str(ACCOUNT_DIGEST, 64)),
}) as unknown as Check<ClientFacts>;

const isClientStatus = object({
  client, signedIn: bool, facts: nullable(isClientFacts), credentialFile: oneOf(['ok', 'missing', 'loose_mode'] as const),
  bindingBytes: int(0, Number.MAX_SAFE_INTEGER), bindingOverLimit: bool,
}) as unknown as Check<ClientStatus>;

const nullableIso = nullable(str(ISO_INSTANT, 30));
const RESULTS: Check<SupervisorResult>[] = [
  object({ kind: literal('bind'), bindingId: str(BINDING_ID, 36) }),
  object({ kind: literal('run'), runId: str(UUID, 36), outcome: oneOf(RUN_OUTCOMES), answer: nullable(text(RUN_CAP_BOUNDS.maxAnswerBytes.max)),
    resetsAt: nullableIso, turns: int(0, 1000) }),
  object({ kind: literal('status'), slot: isSlotReport }),
  object({ kind: literal('status'), client: isClientStatus }),
  object({ kind: literal('logout'), client, logout: outcome }),
  object({ kind: literal('release'), bindingId: str(BINDING_ID, 36), logout: perClient(outcome), dataEmpty: bool, exiting: bool }),
  object({ kind: literal('stop'), runId: str(UUID, 36), state: oneOf(['not_running', 'stopping'] as const) }),
  object({ kind: literal('login'), client, ended: oneOf(['exited', 'timed_out'] as const), exitCode: nullable(int(-1, 255)), status: isClientStatus }),
] as unknown as Check<SupervisorResult>[];

export const isSupervisorResult: Check<SupervisorResult> = (value): value is SupervisorResult => RESULTS.some((check) => check(value));

const FRAMES: Check<SupervisorFrame>[] = [
  object({ t: literal('accepted'), kind: oneOf(SUPERVISOR_REQUESTS), bootId: str(BOOT_ID, 36) }),
  object({ t: literal('step'), step: oneOf(['logout', 'delete', 'verify'] as const), outcome }, { client }),
  object({ t: literal('result'), result: isSupervisorResult }),
  object({ t: literal('error'), code: oneOf(SUPERVISOR_ERRORS) }),
  object({ t: literal('console'), state: oneOf(['started', 'exited', 'timed_out'] as const) }),
  object({ t: literal('signin'), e: literal('device'), url: str(DEVICE_URL, 64), code: str(DEVICE_CODE, 17) }),
  object({ t: literal('signin'), e: literal('url'), url: str(CLAUDE_SIGN_IN_URL, 1600) }),
  object({ t: literal('signin'), e: literal('problem'), problem: oneOf(SIGN_IN_PROBLEMS) }),
  object({ t: literal('run'), e: literal('init'), tools: arrayOf(str(INIT_NAME, 128), 64),
    servers: arrayOf(object({ name: str(INIT_NAME, 128), status: str(/^[a-z_-]{1,32}$/, 32) }), 16) }),
  object({ t: literal('run'), e: literal('tool'), name: str(FLUX_TOOL_NAME, 67) }),
] as unknown as Check<SupervisorFrame>[];

/** The frame, or null when the value is not exactly one of the closed frame shapes. */
export function parseSupervisorFrame(value: unknown): SupervisorFrame | null {
  if (!isPlainObject(value)) return null;
  return FRAMES.some((check) => check(value)) ? (value as SupervisorFrame) : null;
}

/** The result kind a request kind may answer with (status answers with a slot or client report). */
export function resultMatches(kind: SupervisorRequestKind, result: SupervisorResult): boolean {
  return result.kind === kind;
}
