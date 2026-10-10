import type { AssistantSettings, AssistantJoinRequest, UpdateAssistantSettings } from '@flux/contracts';
import type { Principal } from '../principal.js';

/** All methods are transaction-bound; caller identity is checked before looking up another owner's rows. */
export interface AssistantSettingsPort {
  get(ownerUserId: string, workspaceId: string): Promise<AssistantSettings | null>;
  save(ownerUserId: string, workspaceId: string, expected: number, input: UpdateAssistantSettings):
    Promise<AssistantSettings | { conflict: AssistantSettings } | 'OUTSIDE_CONSENT' | 'AUTHORITY_UNAVAILABLE' | null>;
}
export interface AssistantIdentityPort {
  /** Serializes enablement and later project creation, preventing a concurrent create from missing auto-join. */
  lockOwner(ownerUserId: string): Promise<void>;
  ensure(ownerUserId: string, workspaceId: string, agentId: string): Promise<AssistantSettings>;
  remove(ownerUserId: string): Promise<void>;
}
export interface AssistantJoinPort {
  request(owner: Principal, workspaceId: string, projectId: string): Promise<AssistantJoinRequest>;
  respond(manager: Principal, projectId: string, requestId: string, allow: boolean): Promise<AssistantJoinRequest>;
}
