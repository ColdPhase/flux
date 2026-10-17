// "On a schedule" and the morning summary (F-027 AST-7, A8 #408). A schedule is the owner's own sentence, run by their
// assistant at a time in their time zone, in one project. The words "job" and "cron" are internal, except inside a
// schedule's *More* (AST-10.2).

export const ASSISTANT_JOB_LIMITS = {
  /** The row's name; taken from the first words of the sentence when the owner gives none. */
  title: 60,
  /** The owner's sentence: the instruction the run gets (the same bound as any assistant request). */
  text: 4000,
  /** Schedules per owner (enabled or not). */
  perOwner: 20,
  /** Runs a day for one schedule (AST-7 "Spacing and caps"), within the assistant's background runs a day. */
  runsPerDay: 12,
  /** History kept per schedule (AST-7 "history (last 20)"). */
  history: 20,
  /** A run that could not start within this many minutes of its time is skipped (AST-7 "Missed runs"). */
  missedMinutes: 10,
  /** Failures in a row that pause a schedule (AST-7 "Failures"). */
  failuresToPause: 3,
  /** A deleted schedule can be brought back with Undo for this long (hours). */
  undoHours: 24,
} as const;

/** The version of the note about background use of a subscription (AST-2). Shown once per account and version. */
export const ASSISTANT_BACKGROUND_NOTE_VERSION = 'ast-2.2026-10-09';

/** The default "while I work" window: 9:00 to 17:00 on weekdays, editable (AST-7 "When"). */
export const ASSISTANT_WORK_WINDOW = { from: '09:00', to: '17:00' } as const;

/** Local clock times are "HH:MM"; weekdays count from Monday (1) to Sunday (7). */
export type AssistantJobSchedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  | { kind: 'weekly'; at: string; weekday: number }
  | { kind: 'hourly'; from: string; to: string }
  | { kind: 'cron'; cron: string }
  /** One time only ("Do it at 14:00"): an ISO instant. */
  | { kind: 'once'; at: string };
export type AssistantJobScheduleKind = AssistantJobSchedule['kind'];

export type AssistantJobRunState = 'running' | 'done' | 'skipped' | 'failed';
export type AssistantJobRunTrigger = 'schedule' | 'now';

/** One line of a schedule's history. `line` is the plain result: "Done, 2 things need you", "Skipped: Flux was off at 9:00". */
export interface AssistantJobRun {
  id: string;
  jobId: string;
  /** The scheduled time (the moment of the tap for Run now). */
  firedAt: string;
  firedBy: AssistantJobRunTrigger;
  state: AssistantJobRunState;
  line: string;
  /** The result needs the owner (one Inbox item exists for it). */
  needsYou: boolean;
  /** The assistant run behind it, when one started. */
  runId: string | null;
  finishedAt: string | null;
}

/** What the owner sees of one schedule. Nobody else can read it (404). */
export interface AssistantJob {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  title: string;
  text: string;
  schedule: AssistantJobSchedule;
  timeZone: string;
  /** "Every Monday at 9:00". */
  words: string;
  /** Post the result in the project conversation (under *More*); null when the schedule keeps its result in Recent. */
  conversationId: string | null;
  enabled: boolean;
  /** Prepared from a request and still waiting for the owner's tap (never enabled by anyone else). */
  prepared: boolean;
  /** The owner's request that prepared it; the conversation offers *Turn on* under that answer. */
  preparedRunId: string | null;
  /** Why it is off by itself: three failures in a row. */
  pausedReason: 'failures' | null;
  /** The next three times, in the owner's time zone ("Mon 9:00"); empty when off. */
  next: { at: string; label: string }[];
  /** The latest history line, when there is one. */
  last: { at: string; state: AssistantJobRunState; line: string } | null;
  /** A run of this schedule is working now. */
  running: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssistantJob {
  projectId: string;
  /** Optional: the first words of `text` name the schedule. */
  title?: string;
  text: string;
  schedule: AssistantJobSchedule;
  timeZone: string;
  /** Post the result in the project conversation (More). */
  postToConversation?: boolean;
  /** The conversation a one-off "Do it at" belongs to. */
  conversationId?: string;
  /** `false` creates the schedule off (the sheet always creates it on with *Turn on*). */
  enabled?: boolean;
  /** The version of the background-use note the owner saw, when the account needs one (AST-2.1). */
  noteVersion?: string;
}
export interface UpdateAssistantJob {
  expectedVersion: number;
  title?: string;
  text?: string;
  schedule?: AssistantJobSchedule;
  timeZone?: string;
  projectId?: string;
  postToConversation?: boolean;
  enabled?: boolean;
  noteVersion?: string;
}

/** What the sheet shows before *Turn on*: the note about background use, when this account has not seen it (AST-2.1). */
export interface AssistantBackgroundNote {
  /** Null: nothing to show, only the meta line. */
  note: string | null;
  version: string;
  /** "Runs on your Claude plan" (the one meta line of every sheet). */
  meta: string;
  /** For a Claude Max or Team plan: the line about monthly API credits, with the plan named (AST-2 "Your plan includes …"). */
  credits: string | null;
}

export const assistantJobsPath = (workspaceId: string, ownerUserId: string) => `/api/v1/workspaces/${workspaceId}/assistants/${ownerUserId}/schedules`;
export const assistantJobPath = (workspaceId: string, ownerUserId: string, jobId: string) => `${assistantJobsPath(workspaceId, ownerUserId)}/${jobId}`;
export const assistantJobRunNowPath = (workspaceId: string, ownerUserId: string, jobId: string) => `${assistantJobPath(workspaceId, ownerUserId, jobId)}/run`;
export const assistantJobRestorePath = (workspaceId: string, ownerUserId: string, jobId: string) => `${assistantJobPath(workspaceId, ownerUserId, jobId)}/restore`;
export const assistantJobHistoryPath = (workspaceId: string, ownerUserId: string, jobId: string) => `${assistantJobPath(workspaceId, ownerUserId, jobId)}/history`;
export const assistantJobNotePath = (workspaceId: string, ownerUserId: string) => `/api/v1/workspaces/${workspaceId}/assistants/${ownerUserId}/background-note`;
/** The cron preview of *More*: refuses more than once an hour, shows the next three times in words. */
export const assistantJobPreviewPath = (workspaceId: string, ownerUserId: string) => `${assistantJobsPath(workspaceId, ownerUserId)}/preview`;

export interface AssistantJobPreview {
  words: string;
  next: { at: string; label: string }[];
}

/** The morning summary written by the assistant (AST-7 "The morning summary"). */
export const ASSISTANT_MORNING_SUMMARY_PATH = '/api/v1/assistant/morning-summary';
export interface AssistantMorningSummary {
  /** Whether the owner asked the assistant to write it. */
  byAssistant: boolean;
  /** Today's line for the Home greeting, or null (nothing written yet, or the plain summary went out). */
  line: string | null;
  /** The local day of the line ("YYYY-MM-DD"). */
  day: string | null;
}
export interface SetMorningSummaryByAssistant {
  on: boolean;
  /** The version of the background-use note the owner saw (AST-2.1). */
  noteVersion?: string;
  /** The browser's time zone, taken when the person's zone is still UTC (as the Notifications row does). */
  timeZone?: string;
}
