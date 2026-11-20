import { randomUUID } from 'node:crypto';
import { DomainError, redactedError } from '@flux/core';
import { databaseConflict } from '../http/errors.js';
import { taskUseDomainError } from '../work/task-use-errors.js';

export function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** The code of a tool call that failed inside Flux: an error nobody raised on purpose (#1555). */
export const TOOL_FAILED = 'TOOL_FAILED';
/** Where an unexpected error rides on its result, for the one place that knows the tool and the run to log it (`recordToolCall`). */
const UNEXPECTED = Symbol('flux.tool.unexpected');
type Unexpected = { error: unknown; errorId: string };

export function toolError(error: unknown) {
  // A database refusal that is the sender's input (a NUL character, #838) is told as such, not as a broken tool.
  error = databaseConflict(taskUseDomainError(error));
  if (error instanceof DomainError) return { ...toolResult({ code: error.code, error: error.message }), isError: true as const };
  // Anything else failed inside Flux (#1555): the model is told that it failed, with an id the operator finds in the log, never that the
  // tool does not exist, and never the error's own words (they can quote a statement, a file path or the space's text).
  const errorId = randomUUID();
  const result = { ...toolResult({ code: TOOL_FAILED, error: `Flux failed to do this because of an error inside Flux (error id ${errorId}). `
    + 'Tell the person it failed and give them this error id; whoever runs Flux finds it in the log.' }), isError: true as const };
  Object.defineProperty(result, UNEXPECTED, { value: { error, errorId } satisfies Unexpected, enumerable: false });
  return result;
}

/** The error id of a result `toolError` made from an unexpected error; null for every other result. */
export const failedToolId = (result: unknown): string | null =>
  (result as { [UNEXPECTED]?: Unexpected } | null | undefined)?.[UNEXPECTED]?.errorId ?? null;

/** What the tool log takes: Fastify's logger (pino) or anything with the same two methods. */
export interface ToolLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
const stderrLog = (level: number): ToolLog['info'] => (fields, msg) => { process.stderr.write(`${JSON.stringify({ level, time: Date.now(), ...fields, msg })}\n`); };
let toolLog: ToolLog = { info: stderrLog(30), error: stderrLog(50) };
/** The API's logger for every tool call (app.ts), as the other agent ports are configured once for the process. */
export function configureToolLog(log: ToolLog) { toolLog = log; }

/** An error's stack without its message: the frames say where it failed, never what it was given. */
function frames(error: unknown): string | null {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return null;
  // The message's own lines come first (`Name: message`), and a line of it may itself look like a frame: they are skipped by count.
  const message = (error as { message?: unknown }).message;
  const head = typeof message === 'string' ? message.split('\n').length : 1;
  const lines = stack.split('\n').slice(head).filter((line) => /^\s+at /.test(line)).slice(0, 30);
  return lines.length ? lines.map((line) => line.trim()).join('\n') : null;
}
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A failed result's code, read only when it is one: a refusal in plain words has none. */
function codeOf(result: { content?: unknown; isError?: boolean } | null | undefined): string | null {
  if (!result?.isError) return null;
  const text = Array.isArray(result.content) ? (result.content[0] as { text?: unknown } | undefined)?.text : undefined;
  try {
    const code = typeof text === 'string' ? (JSON.parse(text) as { code?: unknown }).code : undefined;
    return typeof code === 'string' && CODE.test(code) ? code : 'REFUSED';
  } catch { return 'REFUSED'; }
}

export interface ToolCallRecord {
  tool: string;
  operation: string | null;
  runId: string | null;
  connectionId: string;
  /** The waiting change an owner's Approve repeats. */
  changeId?: string;
  ms: number;
}
/**
 * One line per tool call (#1555): which tool ran for which run or connection, its outcome (ok, or the error's code) and how long it took;
 * never its arguments or what it returned. A call that failed inside Flux adds one error line with the error id the model was given, the
 * error's class and codes (`redactedError`) and its stack frames, so an operator settles a case like #1555 from the log alone.
 */
export function recordToolCall(record: ToolCallRecord, result: { content?: unknown; isError?: boolean } | null | undefined) {
  const code = codeOf(result);
  const unexpected = (result as { [UNEXPECTED]?: Unexpected } | null | undefined)?.[UNEXPECTED];
  const fields = { event: 'tool', tool: record.tool, operation: record.operation, runId: record.runId, connectionId: record.connectionId,
    ...(record.changeId ? { changeId: record.changeId } : {}) };
  if (unexpected) toolLog.error({ ...fields, errorId: unexpected.errorId, error: redactedError(unexpected.error).message, stack: frames(unexpected.error) },
    'An agent tool failed inside Flux');
  toolLog.info({ ...fields, outcome: code ? 'error' : 'ok', ...(code ? { code } : {}), ...(unexpected ? { errorId: unexpected.errorId } : {}),
    ms: Math.round(record.ms) }, 'Agent tool call');
}
