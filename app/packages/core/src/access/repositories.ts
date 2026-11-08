import type { WorkspaceRole } from '@flux/contracts';
import type { EventRepository } from '../events.js';
import type { EncryptionViewInput } from '../encryption/view.js';
import type { Executor } from '../types.js';
import type { Actor, AccessReader } from './ports.js';
import type { Principal } from '../principal.js';
import type { AccountLookup, AccountRecord, AgentRecord, DraftRecord, GrantRecord, GrantWrite, MemberRecord,
  ProjectRecord, SweptRun, WorkspaceRecord } from './records.js';

// The persistence ports of the access use cases (issues #46, #91). Core states what each use case needs;
// `@flux/db` implements them (`repositories/{workspaces,projects,agents,drafts}.ts` and the F-029/F-030 row
// modules) and the apps pass `accessPorts` in, bound to the transaction or connection a step runs in. A
// repository makes no access decision: the use case evaluates the policy first and takes the locks in the
// order its comments document. Keep this file free of persistence imports.

export interface WorkspaceRepository {
  /** The workspace, then its first owner. `company` marks the one company workspace (F-037). */
  createWithOwner(row: { id: string; name: string; createdBy: string; company?: boolean }): Promise<WorkspaceRecord>;
  /** Serializes company setup (F-037): a transaction-scoped lock every first sign-in takes before it reads the company. */
  lockCompanySetup(): Promise<void>;
  /** The company workspace (F-037), or null before setup. */
  company(): Promise<WorkspaceRecord | null>;
  /** A new name, one version on. */
  rename(workspaceId: string, name: string): Promise<WorkspaceRecord>;
  /** The person's workspaces with their role, oldest first. */
  forMember(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]>;
  workspaceOfAgent(agentId: string): Promise<string | null>;
  get(workspaceId: string): Promise<WorkspaceRecord | null>;
  members(workspaceId: string): Promise<{ member: MemberRecord; email: string; name: string }[]>;
  /** The workspace row `FOR NO KEY UPDATE` (nothing for an id that is not a UUID). */
  lock(workspaceId: string): Promise<void>;
  ownerCount(workspaceId: string): Promise<number>;
  findAccount(lookup: AccountLookup): Promise<AccountRecord | null>;
  /** The new membership, or null when the account is already a member. */
  insertMember(row: { workspaceId: string; userId: string; role: WorkspaceRole; createdBy: string }): Promise<MemberRecord | null>;
  /** Someone who became a guest is no longer a space admin: their `manager` grants become plain membership. */
  endSpaceAdmin(workspaceId: string, userId: string): Promise<void>;
  /** With `lock` the membership row is held `FOR SHARE` until the transaction ends (a person leaving the company waits for it). */
  isMember(workspaceId: string, userId: string, options?: { lock?: boolean }): Promise<boolean>;
  /** Remembers someone who left or was removed, for Restore. */
  recordRemoved(workspaceId: string, userId: string, removedBy: string): Promise<void>;
  /** Everyone who left or was removed and has not joined again, newest first. */
  removedPeople(workspaceId: string): Promise<{ userId: string; removedAt: Date; email: string; name: string }[]>;
  isRemoved(workspaceId: string, userId: string): Promise<boolean>;
  /** A membership row `FOR UPDATE`. */
  lockMember(workspaceId: string, userId: string): Promise<MemberRecord | null>;
  setRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<MemberRecord>;
  deleteMember(workspaceId: string, userId: string): Promise<void>;
  /** The company this encrypted workspace is a space of (F-037, #874), or null for any other workspace. */
  companyOf(workspaceId: string): Promise<string | null>;
  /** The encrypted spaces of this company that the person is a member of: leaving the company ends their place in them. */
  spacesOfCompanyWith(companyId: string, userId: string): Promise<string[]>;
  /** Whether the workspace already holds a project (an encrypted space holds exactly one). */
  hasProject(workspaceId: string): Promise<boolean>;
}

/** A `workspace_invites` row (F-035). */
export interface InviteRow {
  id: string; workspaceId: string; role: 'admin' | 'member' | 'guest'; email: string | null; tokenHash: string; createdBy: string;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokedBy: string | null; acceptedAt: Date | null; acceptedBy: string | null;
}

/** Invite link rows (F-035, `workspaceInviteRepository`). */
export interface InviteRepository {
  insert(row: { id: string; workspaceId: string; role: InviteRow['role']; email: string | null; tokenHash: string; createdBy: string; expiresAt: Date }): Promise<InviteRow>;
  /** Pending invites with their creator's name, newest first. */
  pending(workspaceId: string, now: Date): Promise<{ invite: InviteRow; creatorName: string }[]>;
  pendingCount(workspaceId: string, now: Date): Promise<number>;
  /** One invite with its workspace and creator; with `lock`, the invite row `FOR UPDATE`. */
  get(inviteId: string, options?: { lock?: boolean }): Promise<{ invite: InviteRow; workspaceName: string; encrypted: boolean; creatorName: string } | null>;
  /** The person's role in the workspace, or null. */
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  revoke(inviteId: string, revokedBy: string, at: Date): Promise<void>;
  markAccepted(inviteId: string, acceptedBy: string, at: Date): Promise<void>;
}

/** The rows of an encrypted workspace (F-030) that membership changes and workspace reads need (`workspaceEncryptionRows`). */
export interface WorkspaceEncryptionRows {
  sealed(workspaceId: string): Promise<boolean>;
  /** The person's role in the workspace, or null; with `lock` the membership row is held `FOR SHARE` until the transaction ends. */
  memberRole(workspaceId: string, userId: string, options?: { lock?: boolean }): Promise<WorkspaceRole | null>;
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

/** The turn-off sweep (AG-10) for one space and the epoch its flip set (`spaceAiSweepRows`). One method is one step. */
export interface SpaceAiSweepRows {
  endQueuedRuns(projectId: string, epoch: number): Promise<SweptRun[]>;
  stopInFlightRuns(projectId: string, epoch: number): Promise<SweptRun[]>;
  closeRunTokens(projectId: string, epoch: number): Promise<number>;
  cancelRequests(projectId: string, epoch: number): Promise<number>;
  stopUnits(projectId: string, epoch: number): Promise<number>;
}

export interface ProjectRepository {
  /** The project row `FOR NO KEY UPDATE`, before a grant change or a view addition (nothing for an id that is not a UUID). */
  lockForGrantChange(projectId: string): Promise<void>;
  insert(row: { id: string; workspaceId: string; name: string; visibility: 'workspace' | 'restricted'; views: string[]; createdBy: string }): Promise<ProjectRecord>;
  get(projectId: string): Promise<ProjectRecord | null>;
  /** The views, one version on. */
  setViews(projectId: string, views: string[]): Promise<ProjectRecord>;
  /** A new name, one version on. */
  rename(projectId: string, workspaceId: string, name: string): Promise<ProjectRecord>;
  /** The AI switch of each space, with who last changed it. */
  aiPolicies(projectIds: string[]): Promise<{ projectId: string; state: 'allowed' | 'blocked'; changedAt: Date; changedBy: string | null }[]>;
  /** The space's AI policy row `FOR UPDATE` (the flip's first lock). */
  lockAiPolicy(projectId: string): Promise<{ projectId: string; state: 'allowed' | 'blocked'; epoch: number } | null>;
  /** The next state with the next epoch. */
  updateAiPolicy(projectId: string, state: 'allowed' | 'blocked', changedBy: string): Promise<{ epoch: number }>;
  /** Erases the space and everything that names it, in the caller's transaction. */
  erase(projectId: string): Promise<void>;
  /** One page of the projects the actor can see with their level; the filter applies before count and page. */
  listVisible(actor: Actor, page: { limit: number; offset: number }): Promise<{ total: number; rows: { project: ProjectRecord; level: number; member: boolean; ai: 'allowed' | 'blocked' | null }[] }>;
  /** The project's grants, leaving out the agents the principal may not see. */
  listGrants(principal: Principal, projectId: string): Promise<GrantRecord[]>;
  /** The workspace's people. */
  members(workspaceId: string): Promise<{ id: string; name: string }[]>;
  /** The workspace's unrevoked agents this principal may see in the project. */
  audienceAgents(principal: Principal, projectId: string, workspaceId: string): Promise<{ id: string; name: string; ownerUserId: string }[]>;
  member(workspaceId: string, userId: string): Promise<MemberRecord | null>;
  /** The workspace's unrevoked agent with this id. */
  /** The principal's grant on the project `FOR UPDATE`. */
  lockGrantOf(projectId: string, userId: string): Promise<GrantRecord | null>;
  /** A grant of the project by id `FOR UPDATE`. */
  lockGrant(projectId: string, grantId: string): Promise<GrantRecord | null>;
  updateGrant(grantId: string, role: GrantRecord['role'], createdBy: string): Promise<GrantWrite>;
  insertGrant(row: { id: string; workspaceId: string; projectId: string; role: GrantRecord['role']; createdBy: string; userId: string }): Promise<GrantWrite>;
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  deleteGrant(grantId: string): Promise<void>;
}

export interface AgentRepository {
  insert(row: { id: string; workspaceId: string; name: string; ownerUserId: string; createdBy: string }): Promise<AgentRecord>;
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
  aiSweep(db: Executor): SpaceAiSweepRows;
  access(db: Executor): RecordReader;
  events(db: Executor): EventRepository;
}
