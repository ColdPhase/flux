import type { WorkspaceRole } from '@flux/contracts';
import type { EventRepository } from '../events.js';
import type { ProjectGoalRecord } from '../project-goals/ports.js';
import type { EncryptionViewInput } from '../encryption/view.js';
import type { Executor } from '../types.js';
import type { Actor, AccessReader } from './ports.js';
import type { Principal } from '../principal.js';
import type { AccountLookup, AccountRecord, AgentRecord, AiPolicyRecord, AiPolicyRow, DraftRecord, GrantRecord, GrantWrite, MemberRecord,
  ProjectRecord, SweptRun, WorkspaceRecord } from './records.js';

// The persistence ports of the access use cases (issues #46, #91). Core states what each use case needs;
// `@flux/db` implements them (`repositories/{workspaces,projects,agents,drafts}.ts` and the F-029/F-030 row
// modules) and the apps pass `accessPorts` in, bound to the transaction or connection a step runs in. A
// repository makes no access decision: the use case evaluates the policy first and takes the locks in the
// order its comments document. Keep this file free of persistence imports.

export interface WorkspaceRepository {
  /** The workspace, then its first owner. */
  createWithOwner(row: { id: string; name: string; createdBy: string }): Promise<WorkspaceRecord>;
  /** The person's workspaces with their role, oldest first. */
  forMember(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]>;
  workspaceOfAgent(agentId: string): Promise<string | null>;
  get(workspaceId: string): Promise<WorkspaceRecord | null>;
  aiPolicies(workspaceIds: string[]): Promise<AiPolicyRow[]>;
  /** The AI policy row `FOR UPDATE`. */
  lockAiPolicy(workspaceId: string): Promise<AiPolicyRecord | null>;
  /** The next state with the next epoch and version. */
  updateAiPolicy(workspaceId: string, state: 'allowed' | 'blocked', changedBy: string): Promise<{ epoch: number }>;
  members(workspaceId: string): Promise<{ member: MemberRecord; email: string; name: string }[]>;
  /** The workspace row `FOR NO KEY UPDATE` (nothing for an id that is not a UUID). */
  lock(workspaceId: string): Promise<void>;
  ownerCount(workspaceId: string): Promise<number>;
  findAccount(lookup: AccountLookup): Promise<AccountRecord | null>;
  /** The new membership, or null when the account is already a member. */
  insertMember(row: { workspaceId: string; userId: string; role: WorkspaceRole; createdBy: string }): Promise<MemberRecord | null>;
  /** A membership row `FOR UPDATE`. */
  lockMember(workspaceId: string, userId: string): Promise<MemberRecord | null>;
  setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MemberRecord>;
  deleteMember(workspaceId: string, userId: string): Promise<void>;
}

/** A `workspace_invites` row (F-035). */
export interface InviteRow {
  id: string; workspaceId: string; role: 'admin' | 'member' | 'guest'; email: string | null; tokenHash: string; createdBy: string;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokedBy: string | null; acceptedAt: Date | null; acceptedBy: string | null;
  /** #763 FT-3: the project joining also opens, or null. */
  projectId: string | null;
}

/** Invite link rows (F-035, `workspaceInviteRepository`). */
export interface InviteRepository {
  insert(row: { id: string; workspaceId: string; role: InviteRow['role']; email: string | null; tokenHash: string; createdBy: string; expiresAt: Date; projectId?: string | null }): Promise<InviteRow>;
  /** Pending invites with their creator's name (and project name), newest first. */
  pending(workspaceId: string, now: Date): Promise<{ invite: InviteRow; creatorName: string; projectName: string | null }[]>;
  pendingCount(workspaceId: string, now: Date): Promise<number>;
  /** One invite with its workspace and creator; with `lock`, the invite row `FOR UPDATE`. */
  get(inviteId: string, options?: { lock?: boolean }): Promise<{ invite: InviteRow; workspaceName: string; encrypted: boolean; creatorName: string; projectName: string | null } | null>;
  /** A project's name inside the workspace, or null. */
  projectName(workspaceId: string, projectId: string): Promise<string | null>;
  /** The person's role in the workspace, or null. */
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  revoke(inviteId: string, revokedBy: string, at: Date): Promise<void>;
  markAccepted(inviteId: string, acceptedBy: string, at: Date): Promise<void>;
}

/** The rows of an encrypted workspace (F-030) that membership changes and workspace reads need (`workspaceEncryptionRows`). */
export interface WorkspaceEncryptionRows {
  sealed(workspaceId: string): Promise<boolean>;
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  /** With `lock: 'update'`, the key row `FOR UPDATE`. */
  keys(workspaceId: string, options: { lock: 'update' }): Promise<unknown>;
  /** The person's unlock password: `last` when it is the workspace's only one (nothing is deleted). */
  dropUnlockPassword(workspaceId: string, userId: string): Promise<'none' | 'deleted' | 'last'>;
  /** Pins the removal records of the holders the role change deleted (F-030 S2c), in its transaction. */
  recordRemovals(workspaceId: string): Promise<number | 'broken'>;
  /** Who has an unlock password here; empty for a plain workspace. */
  passwordHolders(workspaceId: string): Promise<string[]>;
  /** The `encryption` input of each sealed workspace for one reader (a null user for an agent). */
  views(workspaceIds: string[], userId: string | null): Promise<Map<string, EncryptionViewInput>>;
}

/** The turn-off sweep of F-029 for one workspace and the epoch its flip set (`workspaceAiSweepRows`). One method is one step. */
export interface WorkspaceAiSweepRows {
  endQueuedRuns(workspaceId: string, epoch: number): Promise<SweptRun[]>;
  stopInFlightRuns(workspaceId: string, epoch: number): Promise<SweptRun[]>;
  closeRunTokens(workspaceId: string, epoch: number): Promise<number>;
  endComparisons(workspaceId: string, epoch: number): Promise<number>;
  skipReactionEvents(workspaceId: string, epoch: number): Promise<number>;
  cancelRequests(workspaceId: string, epoch: number): Promise<number>;
  stopUnits(workspaceId: string, epoch: number): Promise<number>;
  revokeSessions(workspaceId: string, epoch: number): Promise<number>;
}

export interface ProjectRepository {
  /** The project row `FOR NO KEY UPDATE`, before a grant change or a view addition (nothing for an id that is not a UUID). */
  lockForGrantChange(projectId: string): Promise<void>;
  insert(row: { id: string; workspaceId: string; name: string; visibility: 'workspace' | 'restricted'; views: string[]; createdBy: string }): Promise<ProjectRecord>;
  get(projectId: string): Promise<ProjectRecord | null>;
  /** The views, one version on. */
  setViews(projectId: string, views: string[]): Promise<ProjectRecord>;
  /** The goal each project shows: its current goal, or else its most recently reached one. */
  shownGoals(projectIds: string[]): Promise<Map<string, ProjectGoalRecord>>;
  /** One page of the projects the actor can see with their level; the filter applies before count and page. */
  listVisible(actor: Actor, page: { limit: number; offset: number }): Promise<{ total: number; rows: { project: ProjectRecord; level: number }[] }>;
  /** The project's grants, leaving out the agents the principal may not see. */
  listGrants(principal: Principal, projectId: string): Promise<GrantRecord[]>;
  /** The workspace's people. */
  members(workspaceId: string): Promise<{ id: string; name: string }[]>;
  /** The workspace's unrevoked agents this principal may see in the project. */
  audienceAgents(principal: Principal, projectId: string, workspaceId: string): Promise<{ id: string; name: string; ownerUserId: string | null }[]>;
  member(workspaceId: string, userId: string): Promise<MemberRecord | null>;
  /** The workspace's unrevoked agent with this id. */
  activeAgent(workspaceId: string, agentId: string): Promise<{ id: string } | null>;
  /** The principal's grant on the project `FOR UPDATE`. */
  lockGrantOf(projectId: string, target: { kind: 'human' | 'agent'; id: string }): Promise<GrantRecord | null>;
  /** A grant of the project by id `FOR UPDATE`. */
  lockGrant(projectId: string, grantId: string): Promise<GrantRecord | null>;
  updateGrant(grantId: string, role: GrantRecord['role'], createdBy: string): Promise<GrantWrite>;
  insertGrant(row: { id: string; workspaceId: string; projectId: string; role: GrantRecord['role']; createdBy: string; userId: string | null; agentId: string | null }): Promise<GrantWrite>;
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  deleteGrant(grantId: string): Promise<void>;
}

export interface AgentRepository {
  insert(row: { id: string; workspaceId: string; name: string; ownerUserId: string | null; createdBy: string }): Promise<AgentRecord>;
  /** The workspace's agents this principal may see, oldest first. */
  listVisible(principal: Principal, workspaceId: string): Promise<AgentRecord[]>;
  revoke(agentId: string, revokedAt: Date): Promise<AgentRecord>;
}

export interface DraftRepository {
  insert(row: { id: string; workspaceId: string; projectId: string | null; title: string; body: string; createdBy: string;
    ownerUserId: string | null; ownerAgentId: string | null }): Promise<DraftRecord>;
  /** One page of the drafts the actor can read (optionally in one project); the filter applies before count and page. */
  listVisible(actor: Actor, projectId: string | undefined, page: { limit: number; offset: number }): Promise<{ total: number; rows: DraftRecord[] }>;
  updateText(draftId: string, changes: { title?: string; body?: string }): Promise<DraftRecord>;
  /** Share and move: a new project and audience, one version on. */
  setAudience(draftId: string, audience: { projectId: string | null; visibility: 'private' | 'project' | 'workspace' }): Promise<DraftRecord>;
}

/** The access policy's reader, returning the rows the use cases present. */
export type RecordReader = AccessReader<ProjectRecord, DraftRecord, AgentRecord>;

/**
 * What the access use cases are built from: each member is bound to the transaction or connection a
 * step runs in. `@flux/db` exports the implementation as `accessPorts`; a use case declares the members
 * it uses with `Pick`.
 */
export interface AccessPorts {
  workspaces(db: Executor): WorkspaceRepository;
  invites(db: Executor): InviteRepository;
  projects(db: Executor): ProjectRepository;
  agents(db: Executor): AgentRepository;
  drafts(db: Executor): DraftRepository;
  encryption(db: Executor): WorkspaceEncryptionRows;
  aiSweep(db: Executor): WorkspaceAiSweepRows;
  access(db: Executor): RecordReader;
  events(db: Executor): EventRepository;
}
