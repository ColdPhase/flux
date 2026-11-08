import type { AgentColour, AgentMemoryItem, AiProviderKind, MyAgent } from '@flux/contracts';

/** What makes an agent run (F-036 AG-1): its model and where it runs, its instructions and its colour. */
export interface AgentSetup {
  instructions: string;
  /** Null: the least used colour of the owner's agents. */
  colour: AgentColour | null;
  engine: 'server' | 'runtime';
  /** The API key the model belongs to (`server`); null on a plan. */
  apiKeyId: string | null;
  provider: AiProviderKind;
  model: string | null;
}
export type AgentSetupChanges = Partial<Omit<AgentSetup, 'colour'>>;

/** All methods are transaction-bound; the caller's identity is checked before another owner's rows are looked up. */
export interface AssistantIdentityPort {
  /** Serializes changes of this owner's agents with their enablement and project membership. */
  lockOwner(ownerUserId: string): Promise<void>;
  /** The owner's live agents, oldest first: the first is Assistant. */
  list(ownerUserId: string, workspaceId?: string): Promise<MyAgent[]>;
  get(ownerUserId: string, agentId: string): Promise<MyAgent | null>;
  /** Whether the owner has ever had an agent, deleted ones too: Assistant is made once, when they first connect AI (AG-1). */
  everHad(ownerUserId: string): Promise<boolean>;
  /** Gives an agent identity its AI setup and rights connection, or sets the setup again. */
  ensure(ownerUserId: string, workspaceId: string, agentId: string, setup: AgentSetup): Promise<MyAgent>;
  change(agentId: string, changes: AgentSetupChanges): Promise<void>;
  rename(agentId: string, name: string): Promise<void>;
  /** Deletes the agent: it stops, its open tasks go back to its owner and its memory goes. */
  remove(ownerUserId: string, agentId: string): Promise<void>;
  memory: {
    list(agentId: string): Promise<AgentMemoryItem[]>;
    count(agentId: string): Promise<number>;
    add(ownerUserId: string, agentId: string, workspaceId: string, body: string, source: string): Promise<AgentMemoryItem>;
    edit(agentId: string, itemId: string, body: string): Promise<AgentMemoryItem | null>;
    remove(agentId: string, itemId: string): Promise<boolean>;
  };
}
