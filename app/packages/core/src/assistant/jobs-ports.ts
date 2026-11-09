import type { AssistantJobRunState, AssistantJobRunTrigger, AssistantJobSchedule } from '@flux/contracts';
import type { PersonalRunPorts } from '../personal-runs/ports.js';

// The ports of an agent's schedules (F-036 AG-9, #858). Core states what it needs; the server and the worker supply
// them over Drizzle rows in one transaction, next to the personal-run ports a firing also needs.

export interface JobRecord {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  /** The agent it belongs to: it runs in that agent's private chat and posts its results there. */
  agentId: string;
  title: string;
  text: string;
  /** The web addresses a run of it may read (C-30): only those its owner typed, never the ones the agent wrote into `text`. */
  given: string[];
  schedule: AssistantJobSchedule;
  timeZone: string;
  enabled: boolean;
  prepared: boolean;
  preparedRunId: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  deletedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export type NewJob = Pick<JobRecord, 'id' | 'workspaceId' | 'ownerUserId' | 'agentId' | 'title' | 'text' | 'given' | 'schedule' | 'timeZone' | 'enabled' | 'prepared' | 'nextRunAt'>
  & { preparedRunId?: string | null };
export type JobChanges = Partial<Pick<JobRecord, 'title' | 'text' | 'given' | 'schedule' | 'timeZone' | 'enabled' | 'prepared' | 'nextRunAt' | 'lastRunAt' | 'deletedAt'>>;

export interface JobRunRecord {
  id: string;
  jobId: string;
  ownerUserId: string;
  firedAt: Date;
  firedBy: AssistantJobRunTrigger;
  runId: string | null;
  state: AssistantJobRunState;
  resultLine: string;
  startedAt: Date;
  finishedAt: Date | null;
}
export type NewJobRun = Pick<JobRunRecord, 'id' | 'jobId' | 'ownerUserId' | 'firedAt' | 'firedBy' | 'state' | 'resultLine'> & { finishedAt?: Date | null };
export type JobRunChanges = Partial<Pick<JobRunRecord, 'runId' | 'state' | 'resultLine' | 'finishedAt'>>;

export interface AssistantJobRepository {
  /** An agent's schedules, oldest first, not the deleted ones; none while the owner is a guest of the company (#1059). */
  list(ownerUserId: string, agentId: string): Promise<JobRecord[]>;
  /**
   * Includes deleted ones (Undo of a delete). With `visibleToOwner`, as the owner's own screen reads it: a guest of the company finds none
   * of their schedules (they are kept, hidden and refused until they are a member again, #1059).
   */
  find(id: string, options?: { lock?: boolean; visibleToOwner?: boolean }): Promise<JobRecord | null>;
  /** Whether the owner is a guest of the company now: the tick fires nothing of theirs and writes nothing about it. */
  ownerIsGuest(ownerUserId: string): Promise<boolean>;
  /** Holds an agent's schedule rows until the transaction ends (agent deletion takes them before the owner's lock, as a firing does). */
  lockForAgent(ownerUserId: string, agentId: string): Promise<void>;
  countActive(ownerUserId: string): Promise<number>;
  insert(job: NewJob): Promise<JobRecord>;
  /** Applies the changes and increments the version; the caller holds the row lock. */
  update(id: string, changes: JobChanges): Promise<JobRecord>;
  /** One enabled schedule whose time has come, locked, skipping rows another worker holds (two workers never fire one twice). */
  lockDue(now: Date): Promise<JobRecord | null>;
  /** Deleted schedules past their Undo time leave with their history. */
  purgeDeleted(before: Date): Promise<number>;

  /** Null when this firing already exists (another worker started it) or another run of the schedule is still working. */
  insertRun(run: NewJobRun): Promise<JobRunRecord | null>;
  findRun(id: string, options?: { lock?: boolean }): Promise<JobRunRecord | null>;
  runExists(jobId: string, firedAt: Date, firedBy: AssistantJobRunTrigger): Promise<boolean>;
  updateRun(id: string, changes: JobRunChanges): Promise<JobRunRecord>;
  runsOf(jobId: string, limit: number): Promise<JobRunRecord[]>;
  lastRuns(jobIds: string[]): Promise<Map<string, JobRunRecord>>;
  running(jobIds: string[]): Promise<Set<string>>;
  /** Firings that have not ended, oldest first (one owner's, or everyone's for the tick). */
  openRuns(limit: number, ownerUserId?: string): Promise<JobRunRecord[]>;
  /** History beyond the newest `keep` goes. */
  trimRuns(jobId: string, keep: number): Promise<void>;

  /** The note about background use was accepted for this account (AST-2.1): its version, or null. */
  noteVersion(ownerUserId: string, accountKey: string): Promise<string | null>;
  acceptNote(ownerUserId: string, accountKey: string, version: string): Promise<void>;
}

export interface AssistantJobPorts extends PersonalRunPorts {
  jobs: AssistantJobRepository;
}
export interface AssistantJobUnitOfWork {
  run<T>(work: (ports: AssistantJobPorts) => Promise<T>): Promise<T>;
}
