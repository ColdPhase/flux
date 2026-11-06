import type { AssistantSettings } from '@flux/contracts';

/** All methods are transaction-bound; caller identity is checked before looking up another owner's rows. */
export interface AssistantSettingsPort {
  get(ownerUserId: string, workspaceId: string): Promise<AssistantSettings | null>;
}
export interface AssistantIdentityPort {
  /** Serializes enablement with other changes of this owner's assistant. */
  lockOwner(ownerUserId: string): Promise<void>;
  ensure(ownerUserId: string, workspaceId: string, agentId: string): Promise<AssistantSettings>;
  remove(ownerUserId: string): Promise<void>;
}
