import type { ProjectGrantRole, ProjectVisibility, WorkspaceRole } from '@flux/contracts';
import type { AgentFacts, DraftFacts, ProjectFacts } from './ports.js';

// The rows the access use cases read and write (issues #46, #91). A `@flux/db` repository returns them
// (whole table rows are assignable) and the use cases present them as the API's shapes. Keep this file
// free of persistence imports.

export interface WorkspaceRecord { id: string; name: string; version: number; encrypted: boolean; createdAt: Date }

export interface MemberRecord { workspaceId: string; userId: string; role: WorkspaceRole; createdAt: Date }

export interface AccountRecord { id: string; email: string; name: string; emailVerified: boolean }

export type AccountLookup = { userId: string } | { email: string };

/** A workspace's AI policy row (F-029) as the flip reads it under `FOR UPDATE`. */
export interface AiPolicyRecord { state: 'allowed' | 'blocked'; epoch: number; version: number }

/** One workspace's AI policy with the name of whoever last changed it (null once that account is gone). */
export interface AiPolicyRow {
  workspaceId: string;
  state: 'allowed' | 'blocked';
  version: number;
  changedAt: Date;
  changedBy: string | null;
  changedByName: string | null;
}

export interface ProjectRecord extends ProjectFacts {
  name: string;
  visibility: ProjectVisibility;
  views: string[];
  version: number;
  createdAt: Date;
}

export interface GrantRecord {
  id: string;
  projectId: string;
  userId: string | null;
  agentId: string | null;
  role: ProjectGrantRole;
  createdBy: string;
  createdAt: Date;
}

/** The result of a grant write: the row, or the constraint violation PostgreSQL named, as a code of `ConflictError`. */
export type GrantWrite = { grant: GrantRecord } | { conflict: 'GRANT_CONFLICT' | 'GRANTEE_REMOVED' };

export interface AgentRecord extends AgentFacts { name: string; createdAt: Date }

export interface DraftRecord extends DraftFacts { body: string; createdAt: Date; updatedAt: Date }

/** One personal run the AI turn-off sweep ended or asked to stop, for its owner's progress events. */
export interface SweptRun { id: string; workspaceId: string; projectId: string; conversationId: string; ownerUserId: string; agentId: string; status: string }
