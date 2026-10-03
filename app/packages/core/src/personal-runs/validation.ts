import { createHash } from 'node:crypto';
import {
  PERSONAL_RUN_CONSENT_VERSION,
  PERSONAL_RUN_LIMITS,
  WORK_LIMITS,
  type AiPrice,
  type AssistantRunKind,
  type AssistantRunTarget,
  type AssistantSourceRef,
  type EnablePersonalRunsCommand,
  type InvokeAssistantRunCommand,
  type ResultFinding,
  type UpdatePersonalRunsCommand,
} from '@flux/contracts';
import { InvalidInputError, RuleViolationError } from '../access/errors.js';
import { id, isId } from '../work/validation.js';
import { requestReservationMicros, usageMicros } from '../ai/price.js';
import type { PersonalComputeUsage } from './ports.js';

// Input and output rules of personal runs (#68, O-008). Pure functions shared by every entry
// point and by the worker.

const KINDS: readonly AssistantRunKind[] = ['ask', 'summarize', 'map_thought'];

function cents(value: unknown, label: string, range: { default: number; min: number; max: number }): number {
  if (value === undefined) return range.default;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.min || value > range.max)
    throw new InvalidInputError(`${label} must be an integer from ${range.min} to ${range.max}`);
  return value;
}

/** An IANA time zone Node can resolve; the daily cap resets at its midnight. */
export function timeZone(value: unknown): string {
  if (value === undefined) return 'UTC';
  if (typeof value !== 'string' || !value || value.length > 64) throw new InvalidInputError('timeZone must be an IANA time zone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidInputError('timeZone must be an IANA time zone');
  }
}

export function normalizeEnable(command: EnablePersonalRunsCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('An enablement is required');
  if (command.consentVersion !== PERSONAL_RUN_CONSENT_VERSION)
    throw new RuleViolationError(`Accept the current disclosure ${PERSONAL_RUN_CONSENT_VERSION}`, 'CONSENT_VERSION_MISMATCH');
  const perRunCents = cents(command.perRunCents, 'perRunCents', PERSONAL_RUN_LIMITS.perRunCents);
  const dailyCapCents = cents(command.dailyCapCents, 'dailyCapCents', PERSONAL_RUN_LIMITS.dailyCapCents);
  if (perRunCents > dailyCapCents) throw new InvalidInputError('perRunCents cannot exceed dailyCapCents');
  const connectionId = command.connectionId === undefined ? null : id(command.connectionId, 'connectionId');
  return { agentId: id(command.agentId, 'agentId'), connectionId, perRunCents, dailyCapCents, timeZone: timeZone(command.timeZone) };
}

export function normalizeUpdate(command: UpdatePersonalRunsCommand) {
  if (!command || typeof command !== 'object') throw new InvalidInputError('An update is required');
  const changes: { perRunCents?: number; dailyCapCents?: number; timeZone?: string } = {};
  if (command.perRunCents !== undefined) changes.perRunCents = cents(command.perRunCents, 'perRunCents', PERSONAL_RUN_LIMITS.perRunCents);
  if (command.dailyCapCents !== undefined) changes.dailyCapCents = cents(command.dailyCapCents, 'dailyCapCents', PERSONAL_RUN_LIMITS.dailyCapCents);
  if (command.timeZone !== undefined) changes.timeZone = timeZone(command.timeZone);
  if (!Object.keys(changes).length) throw new InvalidInputError('Nothing to update');
  return changes;
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
 * What one run reserves (PROV-3): its largest possible cost at the connection's price, or null
 * when the connection has no known price and cannot be used.
 */
export function runReservationMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null): number | null {
  return requestReservationMicros(price, PERSONAL_RUN_LIMITS.maxInputTokens, PERSONAL_RUN_LIMITS.maxOutputTokens);
}

export const centsToMicros = (value: number) => value * 10_000;

/** One numbered source a run may cite as `[S<n>]`. */
export interface SuppliedSource {
  label: string;
  ref: AssistantSourceRef;
  text: string;
}

export const SYSTEM_PROMPT = [
  'You are the personal assistant of one Flux user, answering in a project conversation that other project members read.',
  'Use only the numbered sources given. Cite a source as [S<n>] after the statement it supports. Label statements as Fact, Interpretation or Proposal.',
  'If, and only if, the request asks to record a result, add exactly one block',
  '<proposal>{"fact": "...", "interpretation": "...", "title": "...", "finding": "positive" | "negative", "evidence": "...", "finishes": "S<n> of an open work item" | null}</proposal>',
  'at the end. It is only a proposal: a person with authority decides whether it is saved.',
].join('\n');

/** The input text of one request: the request, an earlier committed answer and the sources. */
export function requestInput(request: { kind: AssistantRunKind; prompt: string }, sources: SuppliedSource[], earlier: string | null): string {
  const task = request.kind === 'summarize' ? 'Summarize this conversation.' : request.kind === 'map_thought' ? 'Help with the selected map thought.' : 'Answer the request.';
  const lines = [`Task: ${task}`, `Request: ${request.prompt}`];
  if (earlier) lines.push('', 'Your earlier answer, to continue:', earlier);
  lines.push('', 'Sources:');
  for (const source of sources) lines.push(`[${source.label}] ${source.text}`);
  return lines.join('\n');
}

export interface ParsedProposal {
  fact: string;
  interpretation: string;
  title: string;
  finding: ResultFinding;
  evidence: string;
  finishesWorkId: string | null;
}

const PROPOSAL = /<proposal>([\s\S]*?)<\/proposal>/;

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

/**
 * Splits model output into the answer body, the cited sources and at most one proposal.
 * Citations count only for supplied labels and are renumbered `[1]`… in the order of `sources`; a proposal may finish only a supplied open work item.
 * A malformed proposal is dropped, never guessed.
 */
export function parseOutput(text: string, sources: SuppliedSource[], allowProposal: boolean) {
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  const match = PROPOSAL.exec(text);
  const raw = (match ? text.replace(match[0], '') : text).trim().slice(0, 100_000);
  // A committed answer cites its sources as `[1]`, `[2]`, … in the order of `sources`, so any
  // reader can open exactly the cited object. Labels of sources that were not supplied are
  // removed: they point at nothing the audience could open.
  const cited = new Map<string, AssistantSourceRef>();
  const body = raw.replace(/\s?\[(S\d{1,3})\]/g, (marker, label: string) => {
    const source = byLabel.get(label);
    if (!source) return '';
    if (!cited.has(label)) cited.set(label, source.ref);
    return `${marker.startsWith(' ') ? ' ' : ''}[${[...cited.keys()].indexOf(label) + 1}]`;
  }).trim();
  let proposal: ParsedProposal | null = null;
  if (match && allowProposal) {
    try {
      const raw = JSON.parse(match[1]!) as Record<string, unknown>;
      const fact = bounded(raw.fact, 2000);
      const interpretation = bounded(raw.interpretation, 2000);
      const title = bounded(raw.title, WORK_LIMITS.title);
      const finding = raw.finding === 'positive' || raw.finding === 'negative' ? raw.finding : null;
      const evidence = typeof raw.evidence === 'string' && raw.evidence.length <= WORK_LIMITS.evidence ? raw.evidence.trim() : null;
      const finishes = raw.finishes === null || raw.finishes === undefined ? null : byLabel.get(String(raw.finishes));
      const finishesValid = raw.finishes === null || raw.finishes === undefined || (finishes?.ref.type === 'work' && isId(finishes.ref.id));
      if (fact && interpretation && title && finding && evidence !== null && finishesValid)
        proposal = { fact, interpretation, title, finding, evidence, finishesWorkId: finishes ? finishes.ref.id : null };
    } catch {
      proposal = null;
    }
  }
  return { body, sources: [...cited.values()], proposal };
}
