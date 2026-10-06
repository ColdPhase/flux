import type { WorkStatus } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { ClaimOperation, CoWorkUnit } from './claims.js';

/**
 * Typed co-work checkpoint and the production claim rules (#153, docs/development/cowork-coordination.md
 * "Unit claims over MCP", 2026-10-06). A checkpoint holds observable facts only: progress, the next action, an
 * optional blocker and the exact source revisions the releasing command relied on. It never holds a copied prompt,
 * model reasoning, a transcript or an authority field.
 */
export const COWORK_CHECKPOINT_SCHEMA = 'flux.cowork.checkpoint/1';
export const COWORK_CHECKPOINT_LIMITS = Object.freeze({ summary: 2000, nextAction: 500, blocker: 500 });
export interface CoWorkCheckpointDraft {
  /** Observed progress, changed artifacts and the checks actually run. */
  summary: string;
  nextAction: string;
  blocker: string | null;
}
export interface CoWorkCheckpointSource { materialId: string; version: number }
export interface CoWorkCheckpointProgress extends CoWorkCheckpointDraft {
  schema: typeof COWORK_CHECKPOINT_SCHEMA;
  /** Exactly the releasing command's prepared sources, which #152 locked and found current. */
  sources: CoWorkCheckpointSource[];
}

const DRAFT_KEYS = ['summary', 'nextAction', 'blocker'];
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum)
    throw new InvalidInputError('Checkpoint text fields are bounded and required');
  return value.trim();
}
/** Exactly `{ summary, nextAction, blocker }`; anything else (a prompt, a transcript, authority) is refused. */
export function normalizeCoWorkCheckpointDraft(value: unknown): CoWorkCheckpointDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== DRAFT_KEYS.length
    || Object.keys(value).some((key) => !DRAFT_KEYS.includes(key)))
    throw new InvalidInputError('A checkpoint is exactly a summary, a next action and a blocker');
  const draft = value as Record<string, unknown>;
  return { summary: text(draft.summary, COWORK_CHECKPOINT_LIMITS.summary),
    nextAction: text(draft.nextAction, COWORK_CHECKPOINT_LIMITS.nextAction),
    blocker: draft.blocker === null ? null : text(draft.blocker, COWORK_CHECKPOINT_LIMITS.blocker) };
}
/** The stored progress of a release's checkpoint: the draft plus the command's prepared sources, never client-asserted. */
export function coWorkCheckpointProgress(draft: CoWorkCheckpointDraft, sources: readonly CoWorkCheckpointSource[]): CoWorkCheckpointProgress {
  const normalized = normalizeCoWorkCheckpointDraft(draft);
  return { schema: COWORK_CHECKPOINT_SCHEMA, ...normalized,
    sources: sources.map((source) => ({ materialId: source.materialId, version: source.version })) };
}
/** The typed progress of a stored checkpoint, or null for any other shape (which is never shown). */
export function parseCoWorkCheckpointProgress(value: unknown): CoWorkCheckpointProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { schema, sources, ...draft } = value as Record<string, unknown>;
  if (schema !== COWORK_CHECKPOINT_SCHEMA || !Array.isArray(sources) || sources.length > 50) return null;
  try {
    const typedSources = sources.map((source: unknown) => {
      const ref = source as Record<string, unknown>;
      if (!ref || typeof ref !== 'object' || Object.keys(ref).length !== 2 || typeof ref.materialId !== 'string'
        || !Number.isSafeInteger(ref.version) || (ref.version as number) < 1) throw new InvalidInputError('Invalid checkpoint source');
      return { materialId: ref.materialId, version: ref.version as number };
    });
    return { schema: COWORK_CHECKPOINT_SCHEMA, ...normalizeCoWorkCheckpointDraft(draft), sources: typedSources };
  } catch { return null; }
}

/** Read-only, lock-free current facts the production providers need; the composition supplies them in its transaction. */
export interface CoWorkClaimEligibilityReader {
  /** The unit's task row, already locked by the composition's complete sorted task pass. */
  task(taskId: string): Promise<{ id: string; projectId: string; status: WorkStatus } | null>;
  /** #171: every direct prerequisite done and unparked now, else TASK_PREREQUISITES_UNMET. Takes no lock. */
  requirePrerequisitesMet(taskId: string): Promise<void>;
}
/**
 * Role eligibility for a new claim or a renewal: the task is open, and an execute unit's prerequisites are met now.
 * Release (parking work) and a replay (an observation that resumes nothing) need none. Review and plan units have no
 * prerequisite rule; author/reviewer separation is enforced at creation and transfer.
 */
export async function requireCoWorkClaimEligibility(reader: CoWorkClaimEligibilityReader, unit: CoWorkUnit,
  action: { operation: ClaimOperation; observation: boolean }): Promise<void> {
  if (action.observation || action.operation === 'release') return;
  const task = await reader.task(unit.taskId);
  if (!task || task.id !== unit.taskId || task.projectId !== unit.projectId) throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  if (task.status === 'done' || task.status === 'not_pursued') throw new ConflictError('The task is closed', 'COWORK_TASK_CLOSED');
  if (unit.role === 'execute') await reader.requirePrerequisitesMet(unit.taskId);
}

export interface CoWorkCheckpointSourceReader {
  /** True when every material still exists in this project, whatever its current version. A plain read, no lock. */
  materialsPresent(materialIds: readonly string[]): Promise<boolean>;
}
/**
 * The released checkpoint must be covered by the releasing command's prepared sources at the same versions. A
 * historical checkpoint (seen by a claim, renewal or their replays) needs only current access to its sources: its
 * holder could not know them in advance, and an edit since must not make the unit unclaimable. An untyped
 * checkpoint is reported as not found, so it is never shown.
 */
export async function requireCoWorkCheckpointSources(progressValue: unknown,
  command: { operation: string; sources: readonly CoWorkCheckpointSource[] }, reader: CoWorkCheckpointSourceReader): Promise<CoWorkCheckpointProgress> {
  const progress = parseCoWorkCheckpointProgress(progressValue);
  if (!progress) throw new NotFoundError('Checkpoint', 'COWORK_CHECKPOINT_NOT_FOUND');
  if (command.operation === 'cowork.release') {
    if (progress.sources.some((source) => !command.sources.some((known) =>
      known.materialId === source.materialId && known.version === source.version)))
      throw new ConflictError('The checkpoint needs the exact current sources of this release', 'COWORK_CHECKPOINT_SOURCES_REQUIRED');
    return progress;
  }
  if (progress.sources.length && !await reader.materialsPresent(progress.sources.map((source) => source.materialId)))
    throw new NotFoundError('Checkpoint', 'COWORK_CHECKPOINT_NOT_FOUND');
  return progress;
}
