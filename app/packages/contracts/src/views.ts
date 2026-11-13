import type { Page, Project, ProjectPerson } from './access.js';
import type { AgentQuestions } from './agent-questions.js';
import type { ConversationRootWindow } from './conversation.js';
import type { DocSummary } from './docs.js';
import type { Sketch } from './sketch.js';
import type { ObjectNotice, TaskCreationNotice } from './work.js';
import type { ProjectWorkSummary, WorkAssociations } from './work-read.js';

/**
 * One read per screen (#1109, founder decision 2026-11-12): what a space's frame and its Conversation show, each in one
 * request, in place of a request per part. Every part is read by its own use case with the caller's access, exactly as its
 * own route reads it; the parts' own routes stay for paging and for refreshing one part after an event.
 */

/** `GET`: the space's frame, read when the person enters a space. Never served from a kept answer, so a lost space says so (#592). */
export const projectSpaceShellPath = (projectId: string) => `/api/v1/projects/${projectId}/space-shell`;

/** How many sketches and pages the shell carries: the first page of each, as their own routes answer it. */
export const SPACE_SHELL_LIMITS = { sketches: 20, docs: 100 } as const;

/**
 * The space and what every view of it shows around it. `project` is required: the read answers the space's own refusal
 * (404 for a space the person cannot open, 423 for a locked encrypted workspace). The other parts are context: a part the
 * person may not read, or that could not be read, is `null` and the space still opens.
 */
export interface SpaceShell {
  project: Project;
  /** `GET /projects/:id/people`. */
  people: ProjectPerson[] | null;
  /** The first page of `GET /workspaces/:id/sketches?projectId=…&hideEmpty=true` (`SPACE_SHELL_LIMITS.sketches`). */
  sketches: Page<Sketch> | null;
  /** The first page of `GET /projects/:id/docs` (`SPACE_SHELL_LIMITS.docs`); the client reads further pages only when `total` says so. */
  docs: Page<DocSummary> | null;
  /** `GET /projects/:id/work-summary`. */
  workSummary: ProjectWorkSummary | null;
}

/** `GET`: what the space's Conversation shows when it opens. */
export const projectConversationViewPath = (projectId: string) => `/api/v1/projects/${projectId}/conversation-view`;

/** The first page of each list, as its own route answers it with no query. */
export const CONVERSATION_VIEW_LIMITS = { notices: 100 } as const;

/**
 * The newest roots of the space's one stream with what the stream shows beside them. The roots and sources are required (a
 * refusal of either is the read's refusal); a notice list that fails for a reason other than access is empty, so the stream stays
 * readable without its announcements. The agents' questions and the work associations are `null` when they are not read here,
 * and the client then reads them from their own routes.
 */
export interface ConversationView {
  projectId: string;
  /** `GET /projects/:id/conversation-roots` (the newest window). */
  roots: ConversationRootWindow;
  /** `GET /projects/:id/task-notices` (first page). */
  taskNotices: Page<TaskCreationNotice>;
  /** `GET /projects/:id/object-notices` (first page): the decisions the stream announces. */
  objectNotices: Page<ObjectNotice>;
  /** `GET /projects/:id/agent-questions`; `null` while the space's AI is off (AG-10), when that route refuses. */
  agentQuestions: AgentQuestions | null;
  /**
   * `GET /projects/:id/work-associations?relation=source&limit=50&messageIds=…` for the newest roots' messages (at most 100),
   * the first read the stream makes; `null` when there are no roots.
   */
  workAssociations: WorkAssociations | null;
}
