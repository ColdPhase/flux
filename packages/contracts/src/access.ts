// Wire types for workspaces, projects, grants, agents and drafts (issue #29, AC-2).
// Every route below requires a live session. An object the caller cannot see answers
// 404; a visible object the caller may not change answers 403. Error bodies are ApiError.

export const WORKSPACES_PATH = '/api/v1/workspaces';
export const PROJECTS_PATH = '/api/v1/projects';
export const DRAFTS_PATH = '/api/v1/drafts';
export const AGENTS_PATH = '/api/v1/agents';

export const workspacePath = (workspaceId: string) => `${WORKSPACES_PATH}/${workspaceId}`;
export const workspaceMembersPath = (workspaceId: string) => `${workspacePath(workspaceId)}/members`;
export const workspaceMemberPath = (workspaceId: string, userId: string) => `${workspaceMembersPath(workspaceId)}/${userId}`;
export const workspaceProjectsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/projects`;
export const workspaceAgentsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/agents`;
export const workspaceDraftsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/drafts`;
export const projectPath = (projectId: string) => `${PROJECTS_PATH}/${projectId}`;
export const projectGrantsPath = (projectId: string) => `${projectPath(projectId)}/grants`;
export const projectGrantPath = (projectId: string, grantId: string) => `${projectGrantsPath(projectId)}/${grantId}`;
export const agentPath = (agentId: string) => `${AGENTS_PATH}/${agentId}`;
export const draftPath = (draftId: string) => `${DRAFTS_PATH}/${draftId}`;
export const draftSharePath = (draftId: string) => `${draftPath(draftId)}/share`;
export const draftMovePath = (draftId: string) => `${draftPath(draftId)}/move`;

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type ProjectVisibility = 'workspace' | 'restricted';
/** `denied` is an explicit deny: it wins over every role, grant and visibility rule. */
export type ProjectGrantRole = 'contributor' | 'viewer' | 'denied';
/** The caller's effective access to a project. `manager` is a workspace owner or admin. */
export type ProjectAccess = 'manager' | 'contributor' | 'viewer';
export type DraftVisibility = 'private' | 'project' | 'workspace';

export type PrincipalRef = { kind: 'human'; id: string } | { kind: 'agent'; id: string };

export interface ApiError {
  error: string;
  code: string;
}

/** 409 VERSION_CONFLICT body: the change was not applied; `current` is the latest authorized object. */
export interface VersionConflict<T = Draft> extends ApiError {
  code: 'VERSION_CONFLICT';
  currentVersion: number;
  current: T;
}

/**
 * Optimistic concurrency. Draft update, share and move need the expected version, either
 * as `If-Match: "<version>"` (bare `<version>` is accepted) or as body `expectedVersion`.
 * Missing → 428 PRECONDITION_REQUIRED, stale → 409 VersionConflict. Draft responses carry
 * `ETag: "<version>"`.
 */
export const IF_MATCH_HEADER = 'if-match';
export interface VersionPrecondition {
  expectedVersion?: number;
}

/**
 * Optional on every POST/PATCH under /api/v1: 1–255 visible ASCII characters. A retry
 * with the same key, principal, workspace and operation and the same request returns the
 * stored response (same status and body, plus `Idempotent-Replayed: true`) without
 * running the command again. The same key with a different request → 422
 * IDEMPOTENCY_KEY_REUSED. A concurrent duplicate waits for the first and replays it.
 * Only successful (2xx) responses are stored, for 24 hours; failures can be retried.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

export interface Page<T> {
  items: T[];
  /** Count of rows the caller may see, computed after visibility filtering. */
  total: number;
  limit: number;
  offset: number;
}

export interface PageQuery {
  /** 1–100, default 50. */
  limit?: number;
  /** 0–10000, default 0. */
  offset?: number;
}

export interface Workspace {
  id: string;
  name: string;
  /** Caller's role; null for an agent principal, which acts only through project grants. */
  role: WorkspaceRole | null;
  version: number;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  visibility: ProjectVisibility;
  access: ProjectAccess;
  version: number;
  createdAt: string;
}

export interface ProjectGrant {
  id: string;
  projectId: string;
  principal: PrincipalRef;
  role: ProjectGrantRole;
  createdBy: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  owner: { kind: 'human'; id: string } | { kind: 'workspace' };
  revokedAt: string | null;
  createdAt: string;
}

export interface Draft {
  id: string;
  workspaceId: string;
  projectId: string | null;
  owner: PrincipalRef;
  title: string;
  body: string;
  visibility: DraftVisibility;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceCommand {
  name: string;
}

/** Adds an existing account by id or e-mail address. */
export interface AddMemberCommand {
  userId?: string;
  email?: string;
  role: WorkspaceRole;
}

export interface ChangeRoleCommand {
  role: WorkspaceRole;
}

export interface CreateProjectCommand {
  name: string;
  /** Default `workspace`. A `restricted` project is visible only to managers and grantees. */
  visibility?: ProjectVisibility;
}

/** Creates or replaces the single grant for this principal on the project. */
export interface GrantProjectCommand {
  principal: PrincipalRef;
  role: ProjectGrantRole;
}

export interface CreateAgentCommand {
  name: string;
  /** `self` makes the caller the owner; `workspace` needs an owner or admin. */
  owner: 'self' | 'workspace';
}

/** New drafts are always private to their author. */
export interface CreateDraftCommand {
  title: string;
  body?: string;
  projectId?: string;
}

export interface UpdateDraftCommand extends VersionPrecondition {
  title?: string;
  body?: string;
}

export interface ShareDraftCommand extends VersionPrecondition {
  scope: DraftVisibility;
  /** Required for `project` unless the draft already belongs to a project; must be in the draft's workspace. */
  projectId?: string;
}

/** Moves a draft within its workspace. The resulting audience must be stated explicitly. */
export interface MoveDraftCommand extends VersionPrecondition {
  projectId: string | null;
  visibility: DraftVisibility;
}

export interface DraftListQuery extends PageQuery {
  projectId?: string;
}

// ---------------------------------------------------------------------------------------
// Background job results (issue #29, AC-3)

export const draftSummariesPath = (draftId: string) => `${draftPath(draftId)}/summaries`;
export const draftSummaryPath = (draftId: string, resultId: string) => `${draftSummariesPath(draftId)}/${resultId}`;

export type DraftSummaryStatus = 'queued' | 'running' | 'completed' | 'denied';

/**
 * A `draft.summarize.v1` job result (a deterministic word count for now). The worker
 * rechecks the requester's access before reading the draft and inside the commit
 * transaction; when access was lost the result is not committed and the status is
 * `denied` with the stage at which it was refused.
 */
export interface DraftSummary {
  id: string;
  draftId: string;
  workspaceId: string;
  requestedBy: PrincipalRef;
  status: DraftSummaryStatus;
  deniedAtStage: 'before_read' | 'before_commit' | null;
  /** The draft version the result was computed from. */
  draftVersion: number | null;
  wordCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------------------
// Event stream (issue #29, AC-3)

/**
 * WebSocket upgrade: `GET /api/v1/stream?cursor=<seq|eventId>` with the session cookie and
 * `Origin` equal to the public origin. Rejections before upgrade: 403 ORIGIN_REJECTED,
 * 401 UNAUTHENTICATED, 400 CURSOR_INVALID. Without a cursor the stream starts at the head.
 * The server sends JSON text frames (StreamMessage); client messages are ignored.
 */
export const STREAM_PATH = '/api/v1/stream';

/** Close codes. 4401: the session ended (revoked, expired or signed out); reconnecting needs a new login. */
export const STREAM_CLOSE_UNAUTHENTICATED = 4401;
/** 1013: the client read too slowly; reconnect with the last cursor. 1001: server shutdown. */
export const STREAM_CLOSE_SLOW_CONSUMER = 1013;

export type StreamObjectType = 'workspace' | 'project' | 'draft' | 'agent';

/**
 * One authorized change. It carries identifiers and kind only; the client refetches the
 * object through the HTTP API. Events arrive in `seq` order and may repeat after a
 * reconnect, so clients deduplicate by `id` or `seq`.
 */
export interface StreamEvent {
  type: 'event';
  seq: number;
  id: string;
  kind: string;
  workspaceId: string;
  objectType: StreamObjectType;
  objectId: string;
  createdAt: string;
}

/**
 * Sent once after replay: live delivery follows. `cursor` is the position the server
 * has scanned to (it may be past the last delivered event because unauthorized events
 * are skipped); store it or the last event seq and pass it as `cursor` on reconnect.
 */
export interface StreamReady {
  type: 'ready';
  cursor: number;
}

export type StreamMessage = StreamEvent | StreamReady;
