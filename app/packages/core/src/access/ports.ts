import type { WorkspaceRole } from '@flux/contracts';
import type { Principal } from '../principal.js';

// The port of the access policy (issues #46, #90). `policy.ts` decides over the facts these methods
// return; `@flux/db` (`repositories/access.ts`) is the one implementation and reads them with SQL.
// Core never builds a query. Keep this file free of persistence imports.

/** Current facts about one principal in one workspace, read fresh for every decision. */
export interface Actor {
  principal: Principal;
  workspaceId: string;
  /** Membership role of a person; null for agents and non-members. */
  role: WorkspaceRole | null;
  agent: { ownerUserId: string | null; ownerRole: WorkspaceRole | null } | null;
  /** False for non-members, revoked agents, agents whose owner left, agents of a workspace whose AI is off, and fixtures. */
  active: boolean;
  /** Set when an agent is inactive only because AI is turned off in its workspace (F-029). */
  blockedBy?: 'workspace_ai';
}

/** The workspace AI policy as one check reads it (F-029, #614). */
export interface WorkspaceAi { state: 'allowed' | 'blocked'; epoch: number; version: number }

export interface LoadOptions {
  /**
   * Inside a mutation transaction: lock the membership/agent rows, the draft, and the
   * project and grant rows the decision reads, so a concurrent revocation waits or is seen.
   */
  lock?: boolean;
}

// What a decision needs to know about each kind of object. The reader returns whole table rows,
// which are assignable to these; evaluations are generic in the row, so callers that hold the
// adapter keep every column (the use cases in `domain.ts` map them to the API's shapes).
export interface ProjectFacts { id: string; workspaceId: string; visibility: 'workspace' | 'restricted' }
export interface DraftFacts {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  title: string;
  version: number;
  visibility: 'private' | 'project' | 'workspace';
}
export interface AgentFacts { id: string; workspaceId: string; ownerUserId: string | null; revokedAt: Date | null }
export interface SketchFacts { id: string; workspaceId: string; scope: 'project' | 'private' | 'dm'; projectId: string | null; dmId: string | null }
export interface DmFacts { id: string; workspaceId: string }
export interface AssistantRunFacts { id: string; workspaceId: string; ownerUserId: string }

export interface ActorReads {
  /** The principal's current standing in a workspace. With `lock`, membership/agent rows `FOR SHARE` (the AI policy row first for an agent). */
  loadActor(principal: Principal, workspaceId: string, options?: LoadOptions): Promise<Actor>;
  /** The workspace's AI policy, fresh; a missing row reads as blocked. With `lock`, the row `FOR SHARE`. */
  workspaceAi(workspaceId: string, options?: { lock?: boolean }): Promise<WorkspaceAi>;
}

export interface WorkspaceReads {
  /** Some project of the actor's workspace where the actor's level is at least contributor now. */
  hasWritableProject(actor: Actor): Promise<boolean>;
  /** The workspace row `FOR SHARE`. */
  lockWorkspaceForShare(workspaceId: string): Promise<void>;
}

export interface ProjectReads<P extends ProjectFacts = ProjectFacts> {
  locateProject(projectId: string): Promise<{ workspaceId: string } | null>;
  /** The project row and the actor's grants on it, `FOR SHARE`, grants ordered by id. */
  lockProjectAccess(actor: Actor, projectId: string): Promise<void>;
  /** The project and the actor's access level (0-3) to it, or null when it does not exist. */
  readProject(actor: Actor, projectId: string): Promise<{ project: P; level: number } | null>;
  /** The project row alone `FOR SHARE`. */
  lockProjectForShare(projectId: string): Promise<void>;
}

export interface DraftReads<D extends DraftFacts = DraftFacts> {
  locateDraft(draftId: string): Promise<{ workspaceId: string } | null>;
  /** The draft row `FOR UPDATE`; returns the project it is in. */
  lockDraftForUpdate(draftId: string): Promise<{ projectId: string | null } | null>;
  /** The draft with whether the actor may read it, its project level and ownership. With `lock`, the row `FOR UPDATE`. */
  readDraft(actor: Actor, draftId: string, options: { lock: boolean }): Promise<{ draft: D; readable: boolean; level: number; isOwner: boolean } | null>;
}

export interface AgentReads<A extends AgentFacts = AgentFacts> {
  readAgent(agentId: string): Promise<A | null>;
}

export interface SketchReads<S extends SketchFacts = SketchFacts> {
  locateSketch(sketchId: string): Promise<{ workspaceId: string; projectId: string | null; dmId: string | null } | null>;
  /** The sketch row `FOR NO KEY UPDATE`. */
  lockSketchForNoKeyUpdate(sketchId: string): Promise<void>;
  /** The sketch with whether the actor may read it and its project level. */
  readSketch(actor: Actor, sketchId: string): Promise<{ sketch: S; readable: boolean; level: number } | null>;
  sketchWorkspace(sketchId: string): Promise<string | null>;
}

export interface DmReads<M extends DmFacts = DmFacts> {
  locateDm(dmId: string): Promise<{ workspaceId: string } | null>;
  lockDmForShare(dmId: string): Promise<void>;
  lockDmForNoKeyUpdate(dmId: string): Promise<void>;
  /** One participant's row `FOR SHARE`. */
  lockParticipantForShare(dmId: string, userId: string): Promise<void>;
  /** Every participant row `FOR SHARE`, in user id order; returns the participants. */
  lockParticipantsForShare(dmId: string): Promise<string[]>;
  /** The DM with whether the actor is a current participant. */
  readDm(actor: Actor, dmId: string): Promise<{ dm: M; readable: boolean } | null>;
  /** A DM's kind, pair key and workspace, for the closed-DM rule. */
  dmPair(dmId: string): Promise<{ kind: 'pair' | 'group'; pairKey: string | null; workspaceId: string } | null>;
  isParticipant(dmId: string, userId: string): Promise<boolean>;
  userName(userId: string): Promise<string | null>;
}

export interface AssistantRunReads {
  readAssistantRun(runId: string): Promise<AssistantRunFacts | null>;
}

/**
 * Everything the policy reads. The rows are generic so an adapter that returns whole table rows
 * keeps them in the evaluations; the defaults are the narrow facts decisions use.
 */
export interface AccessReader<
  P extends ProjectFacts = ProjectFacts,
  D extends DraftFacts = DraftFacts,
  A extends AgentFacts = AgentFacts,
  S extends SketchFacts = SketchFacts,
  M extends DmFacts = DmFacts,
> extends ActorReads, WorkspaceReads, ProjectReads<P>, DraftReads<D>, AgentReads<A>, SketchReads<S>, DmReads<M>, AssistantRunReads {}
