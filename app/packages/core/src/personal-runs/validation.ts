import { joinsAddress } from './web-addresses.js';
import { withoutInventedMarks } from './answer-marks.js';
import { CITE_MARK_PATTERN, markKey, type CiteKind } from './cites.js';
import { createHash } from 'node:crypto';
import {
  AGENT_LIMITS,
  PERSONAL_RUN_LIMITS,
  personalRunMaxInputTokens,
  type AiConnectionRef,
  type AiPrice,
  type AssistantRunKind,
  type AssistantRunTarget,
  type AssistantSourceRef,
  type CreateMyAgentCommand,
  type InvokeAssistantRunCommand,
  type UpdateMyAgentCommand,
} from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import { invisibleFormatRefused } from '../access/validation.js';
import { id } from '../work/validation.js';
import { boundedUsageMicros, requestReservationMicros, usageMicros, usageTokensWithin } from '../ai/price.js';
import type { PersonalComputeUsage } from './ports.js';

// Input and output rules of personal runs (#68, O-008). Pure functions shared by every entry
// point and by the worker.

const KINDS: readonly AssistantRunKind[] = ['ask', 'summarize', 'map_thought'];

/** One of the caller's connections as a request names it: a plan, or an API key's id (#854). */
export function connectionRef(value: unknown): AiConnectionRef {
  if (value === 'claude_plan' || value === 'chatgpt_plan') return value;
  return id(value, 'connection').toLowerCase();
}

/** A model id from a connection's list: what is offered decides; this only refuses what can never be one. */
export function modelRef(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new InvalidInputError('model must be a model id');
  return value;
}

const NAME = /^\S(?:.{0,78}\S)?$/;

function agentText(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new InvalidInputError(`${field} must be ${required ? 'at least 1 and ' : ''}at most ${max} characters`);
  return value;
}

/** Setting up an agent names its identity and, optionally, a model of one of the caller's connections and its instructions (#857). Its colour is given, not chosen. */
export function normalizeEnable(command: CreateMyAgentCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('An agent is required');
  return {
    agentId: id(command.agentId, 'agentId'), connection: command.connection === undefined ? undefined : connectionRef(command.connection),
    model: command.model === undefined ? undefined : modelRef(command.model),
    instructions: agentText(command.instructions, 'instructions', AGENT_LIMITS.instructions, false) ?? '',
  };
}

/** A change to an agent: only the fields given. A model comes with its connection. */
export function normalizeAgentChange(command: UpdateMyAgentCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('Change the name, instructions or model');
  const name = agentText(command.name, 'name', 80, true)?.trim();
  if (name !== undefined && !NAME.test(name)) throw new InvalidInputError('name must be 1–80 characters');
  if (name !== undefined) invisibleFormatRefused(name, 'name');
  const instructions = agentText(command.instructions, 'instructions', AGENT_LIMITS.instructions, false);
  if ((command.connection === undefined) !== (command.model === undefined)) throw new InvalidInputError('A model is chosen with its connection');
  const model = command.connection === undefined ? undefined : { connection: connectionRef(command.connection), model: modelRef(command.model) };
  if (name === undefined && instructions === undefined && !model) throw new InvalidInputError('Change the name, instructions or model');
  return { name, instructions, model };
}

/** One remembered item: plain text, 1–500 characters. */
export function memoryText(value: unknown): string {
  const body = agentText(value, 'body', AGENT_LIMITS.memoryItem, true)?.trim();
  if (!body) throw new InvalidInputError(`body must be 1–${AGENT_LIMITS.memoryItem} characters`);
  return body;
}

function target(value: unknown, kind: AssistantRunKind): AssistantRunTarget | null {
  if (value === undefined || value === null) {
    if (kind === 'map_thought') throw new InvalidInputError('A map_thought run needs a thought target');
    return null;
  }
  const raw = value as { type?: unknown; sketchId?: unknown; thoughtId?: unknown };
  if (!raw || typeof raw !== 'object' || raw.type !== 'thought') throw new InvalidInputError('target must be a map thought');
  return { type: 'thought', sketchId: id(raw.sketchId, 'target.sketchId'), thoughtId: id(raw.thoughtId, 'target.thoughtId') };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The request of a run. `ownerId`, `connectionId` and `agentId` are kept only so the use case
 * can refuse a body that names someone else's; they never select anything.
 */
export function normalizeInvoke(command: InvokeAssistantRunCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('A run request is required');
  const clientRunId = id(command.clientRunId, 'clientRunId');
  if (typeof command.kind !== 'string' || !KINDS.includes(command.kind as AssistantRunKind))
    throw new InvalidInputError(`kind must be one of ${KINDS.join(', ')}`);
  const kind = command.kind as AssistantRunKind;
  const prompt = typeof command.prompt === 'string' ? command.prompt.trim() : '';
  if (!prompt || prompt.length > PERSONAL_RUN_LIMITS.prompt) throw new InvalidInputError(`prompt must be 1–${PERSONAL_RUN_LIMITS.prompt} characters`);
  const request = {
    kind, prompt, target: target(command.target, kind),
    continuesRunId: command.continuesRunId === undefined ? null : id(command.continuesRunId, 'continuesRunId'),
  };
  const named = (value: unknown, label: string) => (value === undefined ? null : typeof value === 'string' && value ? value : invalid(label));
  return {
    clientRunId, ...request, fingerprint: fingerprint(request),
    claimed: { ownerId: named(command.ownerId, 'ownerId'), connectionId: named(command.connectionId, 'connectionId'), agentId: named(command.agentId, 'agentId') },
  };
}

function invalid(label: string): never {
  throw new InvalidInputError(`${label} must be an id`);
}

export type NormalizedInvoke = ReturnType<typeof normalizeInvoke>;

/** The request of a retry: the same kind, prompt, target and continuation as the retried run. */
export function retryRequest(run: { kind: AssistantRunKind; prompt: string; targetSketchId: string | null; targetThoughtId: string | null; continuesRunId: string | null }, clientRunId: unknown): NormalizedInvoke {
  const request = {
    kind: run.kind, prompt: run.prompt,
    target: run.targetSketchId && run.targetThoughtId ? { type: 'thought' as const, sketchId: run.targetSketchId, thoughtId: run.targetThoughtId } : null,
    continuesRunId: run.continuesRunId,
  };
  return { clientRunId: id(clientRunId, 'clientRunId'), ...request, fingerprint: fingerprint(request), claimed: { ownerId: null, connectionId: null, agentId: null } };
}

/**
 * Micro-dollars of reported usage: the provider-reported cost when the response carries one,
 * otherwise the tokens at the connection's price (F-020 PROV-3).
 */
export function costMicros(usage: PersonalComputeUsage, price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>): number {
  return usageMicros(price, usage);
}

/**
 * The charge of one run, never above its reservation (PROV-3, #192 B1): null when the reported
 * usage exceeds the run's token limits or its cost exceeds `reservedMicros`.
 */
export function runChargeMicros(usage: PersonalComputeUsage, price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, reservedMicros: number): number | null {
  return boundedUsageMicros(price, usage, { maxInputTokens: PERSONAL_RUN_LIMITS.maxInputTokens, maxOutputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens, reservedMicros });
}

/** Whether reported tokens are within the run's limits, and so may be stored as its usage. */
export function runTokensWithinLimits(usage: PersonalComputeUsage): boolean {
  return usageTokensWithin(usage, PERSONAL_RUN_LIMITS);
}

/**
 * What one request reserves (PROV-3): its largest possible cost at the connection's price, or null
 * when the connection has no known price and cannot be used. A run with tools (#484) has the larger
 * input bound, and when it is offered its provider's own web search (#954) the room for the results of its searches. The searches
 * themselves are not reserved (#1113): their number is not limited, so each is charged as the provider reports it, within what the
 * run has left (`reconcileRequest`).
 */
export function runReservationMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null, tools = false, webSearch = false): number | null {
  return requestReservationMicros(price, personalRunMaxInputTokens(tools, webSearch), PERSONAL_RUN_LIMITS.maxOutputTokens);
}

/**
 * What a run reserves against its API key's daily budget (#854, PROV-3): its turns × the largest possible request at the
 * key's price, never above what is left of the day's budget. Before each further request the loop checks that one more
 * still fits, so the day's spend stays within the budget. `'budget'`: not even one request fits what is left today; null
 * without a known price.
 */
export function budgetedReservationMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null, tools: boolean, leftMicros: number,
  turns: number = PERSONAL_RUN_LIMITS.maxTurns, webSearch = false): number | 'budget' | null {
  const one = runReservationMicros(price, tools, webSearch);
  if (one === null) return null;
  if (one > leftMicros) return 'budget';
  return tools ? Math.min(one * Math.max(1, Math.floor(turns)), leftMicros) : one;
}

export const centsToMicros = (value: number) => value * 10_000;

/** One numbered source an answer may cite as `[S<n>]`. */
export interface SuppliedSource {
  label: string;
  ref: AssistantSourceRef;
}

/** What makes two citations one: the same message, task, thought, decision or page (a page cited at two sections is two places). */
const refKey = (ref: AssistantSourceRef) => `${ref.type}:${ref.id}${ref.type === 'doc' && ref.section ? `#${ref.section.n}` : ''}`;

/**
 * Splits model output into the answer body and the cited sources.
 * Citations count only for supplied labels (`[S3]`) and for the Flux marks (`[doc:ID#2]`, C-62) that `fluxRefs` resolved, by mark key, to an object the run
 * may cite; both are renumbered `[1]`… in the order they stand, one number for an object however it was cited.
 */
export function parseOutput(text: string, sources: readonly SuppliedSource[], fluxRefs: ReadonlyMap<string, AssistantSourceRef> = new Map()) {
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  // Marks the model invented (`[8]`, `[S9]` of no supplied source, `【3†source】`) are taken out first (#1222): what is left of `[n]` after the numbering
  // below is exactly a supplied source's.
  const raw = withoutInventedMarks(text.trim().slice(0, 100_000), new Set(byLabel.keys())).trim();
  // A committed answer cites its sources as `[1]`, `[2]`, … in the order of `sources`, so any
  // reader can open exactly the cited object. Labels of sources that were not supplied, and Flux marks of nothing the run may cite, are
  // removed: they point at nothing the audience could open.
  const marked = (separator: boolean) => {
    const cited: AssistantSourceRef[] = [];
    const numbers = new Map<string, number>();
    const body = raw.replace(new RegExp(String.raw`\s?\[(S\d{1,3})\]|${CITE_MARK_PATTERN.source}`, 'gu'), (marker: string, label: string | undefined, kind?: string, id?: string, section?: string) => {
      const source = label !== undefined ? byLabel.get(label)?.ref : fluxRefs.get(markKey(kind!.toLowerCase() as CiteKind, id!, section ? Number(section) : null));
      // The space before a mark goes with it; a line break stays, so a mark at the start of a line does not join the line above.
      const before = marker.startsWith('\n') ? '\n' : '';
      if (!source) return before || (separator ? ' ' : '');
      const key = refKey(source);
      let number = numbers.get(key);
      if (number === undefined) { cited.push(source); number = cited.length; numbers.set(key, number); }
      return `${marker.startsWith(' ') ? ' ' : before}[${number}]`;
    }).trim();
    return { body, sources: cited };
  };
  // A mark taken out never joins the text on its sides into a web address that was not there (#1149): then a space stands in its place.
  const plain = marked(false);
  return joinsAddress(raw, plain.body) ? marked(true) : plain;
}
