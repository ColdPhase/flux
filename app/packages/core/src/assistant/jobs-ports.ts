import type { AssistantJobRunState, AssistantJobRunTrigger, AssistantJobSchedule } from '@flux/contracts';
import type { PersonalRunPorts } from '../personal-runs/ports.js';

// The ports of "On a schedule" (F-027 AST-7, A8 #408). Core states what it needs; the server and the worker supply
// them over Drizzle rows in one transaction, next to the personal-run ports a firing also needs.

export interface JobRecord {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  projectId: string;
  title: string;
  text: string;
  schedule: AssistantJobSchedule;
  timeZone: string;
  conversationId: string | null;
  postToConversation: boolean;
  enabled: boolean;
  prepared: boolean;
  preparedRunId: string | null;
  pausedReason: 'failures' | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  failureStreak: number;
  deletedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export type NewJob = Pick<JobRecord, 'id' | 'workspaceId' | 'ownerUserId' | 'projectId' | 'title' | 'text' | 'schedule' | 'timeZone' | 'conversationId'
  | 'postToConversation' | 'enabled' | 'prepared' | 'nextRunAt'> & { preparedRunId?: string | null };
export type JobChanges = Partial<Pick<JobRecord, 'projectId' | 'title' | 'text' | 'schedule' | 'timeZone' | 'conversationId' | 'postToConversation' | 'enabled'
  | 'prepared' | 'pausedReason' | 'nextRunAt' | 'lastRunAt' | 'failureStreak' | 'deletedAt'>>;

export interface JobRunRecord {
  id: string;
  jobId: string;
  ownerUserId: string;
  firedAt: Date;
  firedBy: AssistantJobRunTrigger;
  runId: string | null;
  state: AssistantJobRunState;
  resultLine: string;
  needsYou: boolean;
  startedAt: Date;
  finishedAt: Date | null;
}
export type NewJobRun = Pick<JobRunRecord, 'id' | 'jobId' | 'ownerUserId' | 'firedAt' | 'firedBy' | 'state' | 'resultLine'> & { finishedAt?: Date | null };
export type JobRunChanges = Partial<Pick<JobRunRecord, 'runId' | 'state' | 'resultLine' | 'needsYou' | 'finishedAt'>>;

/** What a firing needs to know about the run it started, once that run ended. */
export interface SettledRunFacts {
  appliedChanges: number;
  waitingChanges: number;
}

export interface AssistantJobRepository {
  list(ownerUserId: string, workspaceId: string): Promise<(JobRecord & { projectName: string })[]>;
  /** Includes deleted ones (Undo of a delete). */
  find(id: string, options?: { lock?: boolean }): Promise<(JobRecord & { projectName: string }) | null>;
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
  /** Firings of one schedule that started a run since the start of the owner's local day (a skipped one does not count). */
  runsTodayForJob(jobId: string, timeZone: string): Promise<number>;
  /** Scheduled and morning-summary runs of the owner since the start of their local day. */
  backgroundRunsToday(ownerUserId: string, timeZone: string): Promise<number>;
  /** The owner's "background runs a day" (assistant settings), or null without settings. */
  backgroundLimit(ownerUserId: string, workspaceId: string): Promise<number | null>;

  /** The note about background use was accepted for this account (AST-2.1): its version, or null. */
  noteVersion(ownerUserId: string, accountKey: string): Promise<string | null>;
  acceptNote(ownerUserId: string, accountKey: string, version: string): Promise<void>;
  /** The assistant run's facts for a result line. */
  settledFacts(runId: string): Promise<SettledRunFacts>;
  /** The owner's waiting changes of a run move to the Inbox now (one item, AST-7 "Output"). */
  promoteWaiting(runId: string, now: Date): Promise<number>;
  /** The latest conversation of the project: where a silent run is anchored; null when the project has none. */
  anchorConversation(projectId: string): Promise<string | null>;
  /** A conversation of this project, for "post the result here" and "Do it at". */
  conversationInProject(projectId: string, conversationId: string): Promise<boolean>;
}

/** One Inbox item for the owner (a plain notification about their own assistant); returns its id. */
export interface AssistantJobInbox {
  tell(ownerUserId: string, projectId: string, title: string, body: string, url: string): Promise<string>;
}

export interface AssistantJobPorts extends PersonalRunPorts {
  jobs: AssistantJobRepository;
  inbox: AssistantJobInbox;
}
export interface AssistantJobUnitOfWork {
  run<T>(work: (ports: AssistantJobPorts) => Promise<T>): Promise<T>;
}
