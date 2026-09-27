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

export interface UpdateDraftCommand {
  title?: string;
  body?: string;
}

export interface ShareDraftCommand {
  scope: DraftVisibility;
  /** Required for `project` unless the draft already belongs to a project; must be in the draft's workspace. */
  projectId?: string;
}

/** Moves a draft within its workspace. The resulting audience must be stated explicitly. */
export interface MoveDraftCommand {
  projectId: string | null;
  visibility: DraftVisibility;
}

export interface DraftListQuery extends PageQuery {
  projectId?: string;
}
