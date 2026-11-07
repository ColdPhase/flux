/**
 * People's agents take tasks (#856, F-036 AG-5). A task reaches an agent through its owner: the owner gives it to one of their
 * own agents in the Owner field, or one setting does it when someone assigns a task to them.
 */

/** `GET`: the signed-in person's own agents a task can be given to, and the one the setting names. `PUT`: change the setting. */
export const TASK_TAKING_PATH = '/api/v1/me/task-taking';
export interface TaskTaking {
  /** The person's own agents that run on the server: the Owner field offers these and no other agent. */
  agents: { id: string; name: string }[];
  /** "When someone assigns a task to me: Give it to [agent]". Null is "Do nothing", the default. */
  takes: string | null;
}
export interface SetTaskTaking { agentId: string | null }

/** `GET`: the state of the agent on a task, in one plain line. The same line for everyone who can read the task. */
export const taskAgentPath = (workId: string) => `/api/v1/work/${workId}/agent`;
/** `POST`: Stop. The agent's owner or the space admin may; the owner is told who did. */
export const taskAgentStopPath = (workId: string) => `${taskAgentPath(workId)}/stop`;
/** `POST`: Try again, after it failed. Only the agent's owner. */
export const taskAgentRetryPath = (workId: string) => `${taskAgentPath(workId)}/retry`;

export type TaskAgentLine =
  | 'waiting_for_room' | 'working' | 'waiting_for_ok' | 'paused_by_limit' | 'failed' | 'stopped' | 'done' | 'handed_back';

export interface TaskAgentState {
  /** The agent that holds the task, or the one that last worked on it for a stopped, done or handed-back line. */
  agent: { id: string; name: string; owner: { id: string; name: string } } | null;
  line: TaskAgentLine | null;
  /** The line as the reader sees it: "Working…", "Claude limit reached, resumes at 14:00", "Stopped by Maja · the task is back with Ada". */
  text: string;
  /** With `paused_by_limit`. */
  resumesAt: string | null;
  stoppedBy: { id: string; name: string } | null;
  /** Whether this reader may press Stop, Try again, or Take it back (the owner's own Owner field does the last). */
  canStop: boolean;
  canTryAgain: boolean;
  canTakeBack: boolean;
  /** The run behind the line; its changes carry Undo. */
  runId: string | null;
}
