import type { WorkspaceEncryption } from './encryption.js';

// Wire types for workspaces, projects, grants, agents and drafts (issue #29, AC-2). F-037 (#874): one Flux is one company,
// the one workspace setup makes; people call it the company and a project a space. The paths keep their internal names.
// Every route below requires a live session. An object the caller cannot see answers
// 404; a visible object the caller may not change answers 403. Error bodies are ApiError.

export const WORKSPACES_PATH = '/api/v1/workspaces';
export const PROJECTS_PATH = '/api/v1/projects';
export const DRAFTS_PATH = '/api/v1/drafts';
export const AGENTS_PATH = '/api/v1/agents';

export const workspacePath = (workspaceId: string) => `${WORKSPACES_PATH}/${workspaceId}`;
export const workspaceMembersPath = (workspaceId: string) => `${workspacePath(workspaceId)}/members`;
export const workspaceMemberPath = (workspaceId: string, userId: string) => `${workspaceMembersPath(workspaceId)}/${userId}`;
export const workspaceRemovedPeoplePath = (workspaceId: string) => `${workspacePath(workspaceId)}/removed-people`;
export const workspaceRestorePath = (workspaceId: string, userId: string) => `${workspaceRemovedPeoplePath(workspaceId)}/${userId}/restore`;
export const workspaceProjectsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/projects`;
export const workspaceAgentsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/agents`;
export const workspaceDraftsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/drafts`;
export const projectPath = (projectId: string) => `${PROJECTS_PATH}/${projectId}`;
/** POST: adds one optional view to the project (#351). */
export const projectViewsPath = (projectId: string) => `${projectPath(projectId)}/views`;
export const projectGrantsPath = (projectId: string) => `${projectPath(projectId)}/grants`;
/** GET: the people and agents who can read the project now (#117), for its audience line. */
export const projectPeoplePath = (projectId: string) => `${projectPath(projectId)}/people`;
export const projectGrantPath = (projectId: string, grantId: string) => `${projectGrantsPath(projectId)}/${grantId}`;
export const agentPath = (agentId: string) => `${AGENTS_PATH}/${agentId}`;
export const draftPath = (draftId: string) => `${DRAFTS_PATH}/${draftId}`;
export const draftSharePath = (draftId: string) => `${draftPath(draftId)}/share`;
export const draftMovePath = (draftId: string) => `${draftPath(draftId)}/move`;

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type ProjectVisibility = 'workspace' | 'restricted';
/**
 * A space's people (F-037): `manager` is a space admin and `contributor` a space member; only a person can be a space admin.
 * `denied` is an explicit deny: it wins over every role, grant and visibility rule.
 */
export type ProjectGrantRole = 'manager' | 'contributor' | 'viewer' | 'denied';
/** The caller's effective access to a project. `manager` is a space admin, or a company owner or admin. */
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
  /** F-037: the company, the one workspace setup makes. A test deployment may hold others for isolation. */
  company: boolean;
  /** Caller's role; null for an agent principal, which acts only through project grants. */
  role: WorkspaceRole | null;
  version: number;
  createdAt: string;
  /** F-029 (#614): whether agents and assistants may work here. Every member sees the state. */
  ai: WorkspaceAiPolicy;
  /** F-030 (#655): null for a plain workspace; the lock state and the caller's unlock password otherwise. */
  encryption: WorkspaceEncryption | null;
}

/**
 * The workspace AI policy (F-029). `changedBy` is named only to callers who may read the members;
 * guests get null.
 */
export interface WorkspaceAiPolicy {
  state: 'allowed' | 'blocked';
  version: number;
  changedAt: string;
  changedBy: { id: string; name: string } | null;
  /** F-030: `'encrypted'` when AI can never be turned on here (an encrypted workspace); the client shows no switch. */
  fixed: 'encrypted' | null;
}

/** The refusal of every AI read or action in a workspace whose AI is off (F-029). */
export const WORKSPACE_AI_BLOCKED = 'WORKSPACE_AI_BLOCKED';

/** `PUT`: an owner or admin turns AI off or on for the whole workspace (F-029, S2). If-Match or `expectedVersion`. */
export const workspaceAiPolicyPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai-policy`;
export interface SetWorkspaceAiPolicyCommand { state: 'allowed' | 'blocked'; expectedVersion?: number }
/** What turning AI off stopped at once (the worker repeats the same sweep, so a crash cannot skip it). */
export interface WorkspaceAiSwept {
  runs: number; tokens: number; comparisons: number; reactions: number; requests: number; units: number; sessions: number;
  /** Steps whose transaction failed (each step is its own transaction, so one cannot stop the others); the job retries them. */
  failed: string[];
}
export interface SetWorkspaceAiPolicyResult { ai: WorkspaceAiPolicy; changed: boolean; stopped: WorkspaceAiSwept | null }
/** Recorded with every change, for the workspace's people (never delivered to an agent). */
export const WORKSPACE_AI_POLICY_CHANGED_EVENT = 'workspace.ai_policy_changed.v1';
/** The worker's sweep of one turn-off: `{ workspaceId, epoch }`, touching only work admitted under an older epoch. */
export const WORKSPACE_AI_SWEEP_JOB = 'workspace-ai.sweep.v1';
export interface WorkspaceAiSweepJob { workspaceId: string; epoch: number }

/** Someone who left the company or was removed; an owner or admin can restore them (Settings › Company). */
export interface RemovedPerson {
  userId: string;
  email: string;
  name: string;
  removedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
  /**
   * Only on an owner's or admin's row of an encrypted workspace, and only for a reader who is an owner or admin there:
   * whether that person has an unlock password (F-030). Absent everywhere else.
   */
  unlockPassword?: boolean;
}

/** The views a project shows only once it needs them (#351, F-026 S21). Conversation and Tasks are always there. */
export const PROJECT_VIEWS = ['map', 'docs', 'agents'] as const;
export type ProjectViewId = (typeof PROJECT_VIEWS)[number];
/** F-037: every new space starts the same way, with Conversation, Tasks, Map and Wiki; there are no templates. */
export const NEW_SPACE_VIEWS: readonly ProjectViewId[] = ['map', 'docs'];

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  visibility: ProjectVisibility;
  access: ProjectAccess;
  /** Optional views. A new space has Map and Wiki; use also shows a view (agents with an agent). */
  views: ProjectViewId[];
  /**
   * On a list: whether the reader belongs to this space. False only for a company owner or admin who can reach it without
   * being in it: Settings › Company lists it for them, and their sidebar does not (F-037).
   */
  member?: boolean;
  version: number;
  createdAt: string;
}

/**
 * One principal who can read a project now (#117). Readable by everyone who can read the
 * project, so its audience is never a guess: workspace owners and admins (managers), people
 * with a grant, members of a workspace-visible project, and the agents of those people that the
 * reader may see, which read with their owner's rights (F-036 AG-3). Denied and inactive
 * principals never appear. Ordered people first, then by name.
 */
export interface ProjectPerson {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  access: ProjectAccess;
  /** Agent owner label: a human only when already in this project's current audience. No workspace roster. */
  agentOwner?: { kind: 'human'; id: string; name: string };
}

/** A person's explicit access to a project. Agents have no grants: an agent has exactly its owner's rights (F-036, #855). */
export interface ProjectGrant {
  id: string;
  projectId: string;
  principal: { kind: 'human'; id: string };
  role: ProjectGrantRole;
  createdBy: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  /** The one person the agent belongs to; it acts with exactly their rights (F-036 AG-3). */
  owner: { kind: 'human'; id: string };
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

/** Test deployments only (F-037): production creates the one company at setup and has no route to create another. */
export interface CreateWorkspaceCommand {
  name: string;
}

/** `PATCH /api/v1/workspaces/:id`: a company owner or admin renames the company (Settings › Company). */
export interface RenameWorkspaceCommand {
  name: string;
}

/** Adds an existing account by id or e-mail address. */
export interface AddMemberCommand {
  userId?: string;
  email?: string;
  role: WorkspaceRole;
}

/**
 * Invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035). An owner or admin creates a
 * one-time link with a role; whoever opens it signs in or signs up and joins. The token travels in the link's fragment.
 */
export const INVITES_PATH = '/api/v1/invites';
export const INVITE_PREVIEW_PATH = `${INVITES_PATH}/preview`;
export const INVITE_ACCEPT_PATH = `${INVITES_PATH}/accept`;
/** The web page an invite link opens; the token follows `#`. */
export const INVITE_JOIN_PAGE = '/join';
export const workspaceInvitesPath = (workspaceId: string) => `${workspacePath(workspaceId)}/invites`;
export const workspaceInvitePath = (workspaceId: string, inviteId: string) => `${workspaceInvitesPath(workspaceId)}/${inviteId}`;
/** An invite never makes an owner; `admin` needs an owner to create it. */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;
export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number];
export const INVITE_DEFAULT_EXPIRY_DAYS: InviteExpiryDays = 7;

export interface CreateInviteCommand {
  role: InviteRole;
  /** Locks the link to this address (compared case-insensitively). */
  email?: string | null;
  expiresInDays?: InviteExpiryDays;
}

/** A pending invite as its workspace's owners and admins see it. */
export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  role: InviteRole;
  email: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  /** The full link to copy: `<origin>/join#<token>`. */
  link: string;
}

export interface InviteTokenCommand { token: string }

/** What the link's holder sees before joining: never the locked address itself. */
export interface InvitePreview {
  workspaceName: string;
  invitedBy: string;
  role: InviteRole;
  expiresAt: string;
  emailLocked: boolean;
  encrypted: boolean;
  /** `joined`: the signed-in account already used this link; `member`: it is already in the workspace. */
  state: 'pending' | 'joined' | 'member';
}

export interface AcceptInviteResult {
  status: 'joined' | 'already_member';
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  encrypted: boolean;
  /** An admin of an encrypted workspace without an unlock password: a current holder grants one (F-030). */
  needsUnlockPassword: boolean;
}

export const INVITE_CREATED_EVENT = 'workspace.invite_created.v1';
export const INVITE_REVOKED_EVENT = 'workspace.invite_revoked.v1';

export interface ChangeRoleCommand {
  role: WorkspaceRole;
}

export interface CreateProjectCommand {
  name: string;
  /**
   * Default `restricted` (F-037): only the people added to the space, and company owners and admins, see it; its creator
   * is its first space admin. `workspace` holds the whole company, as the Everyone space does.
   */
  visibility?: ProjectVisibility;
}

/** Adds an optional view to a project. Adding one it already has changes nothing. */
export interface AddProjectViewCommand {
  view: ProjectViewId;
}

/** Creates or replaces the single grant for this person on the project. */
export interface GrantProjectCommand {
  principal: { kind: 'human'; id: string };
  role: ProjectGrantRole;
}

/** An agent always belongs to the person who creates it (F-036); `owner` may be omitted. */
export interface CreateAgentCommand {
  name: string;
  owner?: 'self';
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
 * WebSocket upgrade: `GET /api/v1/stream?cursor=<cursor|eventId>` with the session cookie
 * and `Origin` equal to the public origin. Rejections before upgrade: 403 ORIGIN_REJECTED,
 * 401 UNAUTHENTICATED, 400 CURSOR_INVALID. Without a cursor the stream starts at the head.
 * A cursor is an opaque string issued to the same person (in `StreamEvent.cursor` or
 * `StreamReady.cursor`); it works only for that person and encodes nothing they can read.
 * The server sends JSON text frames (StreamMessage); client messages are ignored.
 */
export const STREAM_PATH = '/api/v1/stream';

/** Close codes. 4401: the session ended (revoked, expired or signed out); reconnecting needs a new login. */
export const STREAM_CLOSE_UNAUTHENTICATED = 4401;
/** 1013: the client read too slowly; reconnect with the last cursor. 1001: server shutdown. */
export const STREAM_CLOSE_SLOW_CONSUMER = 1013;

/** `assistant_run`: a person's own assistant run (#68); its events reach only that person. */
export type StreamObjectType = 'workspace' | 'project' | 'draft' | 'agent' | 'sketch' | 'dm' | 'assistant_run';

/**
 * One authorized change. It carries identifiers and kind only; the client refetches the
 * object through the HTTP API. Events arrive in commit order and may repeat after a
 * reconnect, so clients deduplicate by `id`. `cursor` resumes after this event.
 */
export interface StreamEvent {
  type: 'event';
  cursor: string;
  id: string;
  kind: string;
  workspaceId: string;
  objectType: StreamObjectType;
  objectId: string;
  createdAt: string;
}

/**
 * Sent once after replay: live delivery follows. `cursor` resumes after the last event
 * this person may currently see (not the global head), so it does not change when events
 * they cannot see happen. Store it, or the latest `StreamEvent.cursor`, for reconnects.
 */
export interface StreamReady {
  type: 'ready';
  cursor: string;
}

export type StreamMessage = StreamEvent | StreamReady;
