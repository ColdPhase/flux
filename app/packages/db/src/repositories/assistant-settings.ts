import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ASSISTANT_PLAN_MODELS, nextAgentColour, type AgentColour, type AgentMayDo, type AgentMemoryItem, type AiProviderKind, type MyAgent } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { companyGuestSql } from './access.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const s = schema.assistantSettings, a = schema.agents, k = schema.agentConnections, m = schema.agentMemoryItems;

export interface AssistantAuthority {
  requireWorkspace(ownerUserId: string, workspaceId: string, tx: Transaction): Promise<void>;
  requireAgent(ownerUserId: string, workspaceId: string, agentId: string, tx: Transaction): Promise<void>;
}

/** What makes an agent run (F-036 AG-1): its model and where it runs, its instructions and its colour. */
export interface AgentSetup {
  instructions: string;
  colour: AgentColour | null;
  engine: 'server' | 'runtime';
  /** The API key the model belongs to (`server`); null on a plan. */
  apiKeyId: string | null;
  provider: AiProviderKind;
  model: string | null;
}
export type AgentSetupChanges = Partial<Omit<AgentSetup, 'colour'>>;

type Row = { s: typeof s.$inferSelect; name: string; mayDo: AgentMayDo };
const planOf = (provider: AiProviderKind) => (provider === 'openai' ? 'codex' : 'claude_code') as 'claude_code' | 'codex';

function view(row: Row, first: string | undefined): MyAgent {
  const plan = row.s.engine === 'runtime';
  return {
    id: row.s.agentId, workspaceId: row.s.workspaceId, name: row.name, instructions: row.s.instructions, colour: row.s.colour,
    model: plan
      ? { connection: planOf(row.s.provider) === 'codex' ? 'chatgpt_plan' : 'claude_plan', model: row.s.model ?? ASSISTANT_PLAN_MODELS[planOf(row.s.provider)].default }
      : { connection: row.s.apiKeyId ?? '', model: row.s.model ?? '' },
    mayDo: row.mayDo, connectionId: row.s.connectionId, answersAi: row.s.agentId === first, createdAt: row.s.createdAt.toISOString(),
  };
}

/** Transaction-bound persistence of a person's agents. Their rights are their owner's; they have no grants, switches or project list. */
export function assistantSettingsRows(tx: Transaction, authority: AssistantAuthority) {
  /**
   * The owner's live agents with a setup, oldest first: the first is Assistant (F-036 AG-1). A guest of the company has none to see or
   * change: their agents are kept, hidden and refused until they are a member again (AG-2, C-50).
   */
  const rows = async (ownerUserId: string, workspaceId?: string, lock = false): Promise<Row[]> => {
    const query = tx.select({ s, name: a.name, mayDo: k.mayDo }).from(s).innerJoin(a, eq(a.id, s.agentId)).innerJoin(k, eq(k.id, s.connectionId))
      .where(and(eq(s.ownerUserId, ownerUserId), isNull(a.revokedAt), isNull(k.revokedAt), workspaceId ? eq(s.workspaceId, workspaceId) : undefined,
        sql`NOT ${companyGuestSql(s.ownerUserId)}`))
      .orderBy(asc(s.createdAt), asc(s.agentId));
    return lock ? query.for('update', { of: s }) : query.for('share', { of: s });
  };
  const list = async (ownerUserId: string, workspaceId?: string): Promise<MyAgent[]> => {
    const found = await rows(ownerUserId, workspaceId);
    return found.map((row) => view(row, found[0]?.s.agentId));
  };
  const get = async (ownerUserId: string, agentId: string): Promise<MyAgent | null> => (await list(ownerUserId)).find((agent) => agent.id === agentId) ?? null;
  return {
    lockOwner: (ownerUserId: string) => lockAssistantOwner(tx, ownerUserId),
    list,
    get,
    async everHad(ownerUserId: string): Promise<boolean> {
      const [row] = await tx.select({ agentId: s.agentId }).from(s).where(eq(s.ownerUserId, ownerUserId)).limit(1);
      return Boolean(row);
    },
    /** The colour a new agent is given: the least used of the owner's own. */
    async nextColour(ownerUserId: string, workspaceId: string): Promise<AgentColour> {
      return nextAgentColour((await rows(ownerUserId, workspaceId)).map((row) => row.s.colour));
    },
    async isLocalClient(agentId: string): Promise<boolean> {
      const [row] = await tx.select({ id: k.id }).from(k).where(and(eq(k.agentId, agentId), ne(k.computeSource, 'owner_assistant'))).limit(1);
      return Boolean(row);
    },
    /** Gives an agent identity its AI setup and its rights connection, or sets the setup again on an agent that has them. */
    async ensure(ownerUserId: string, workspaceId: string, agentId: string, setup: AgentSetup): Promise<MyAgent> {
      await lockAssistantOwner(tx, ownerUserId);
      await authority.requireAgent(ownerUserId, workspaceId, agentId, tx);
      await authority.requireWorkspace(ownerUserId, workspaceId, tx);
      const [agent] = await tx.select({ name: a.name }).from(a).where(eq(a.id, agentId));
      const colour = setup.colour ?? nextAgentColour((await rows(ownerUserId, workspaceId)).map((row) => row.s.colour));
      const [existing] = await tx.select().from(s).where(eq(s.agentId, agentId)).for('update');
      if (!existing) {
        const connectionId = randomUUID();
        await tx.insert(k).values({ id: connectionId, workspaceId, ownerUserId, agentId, name: agent?.name ?? 'Agent', clientDesignation: 'other',
          computeSource: 'owner_assistant' });
        await tx.insert(s).values({ workspaceId, ownerUserId, agentId, connectionId, instructions: setup.instructions, colour,
          engine: setup.engine, apiKeyId: setup.apiKeyId, provider: setup.provider, model: setup.model });
      } else {
        await tx.update(k).set({ revokedAt: null, updatedAt: new Date() }).where(eq(k.id, existing.connectionId));
        await tx.update(s).set({ instructions: setup.instructions, colour, engine: setup.engine, apiKeyId: setup.apiKeyId, provider: setup.provider,
          model: setup.model, version: sql`${s.version} + 1`, updatedAt: new Date() }).where(eq(s.agentId, agentId));
      }
      return (await get(ownerUserId, agentId))!;
    },
    /** Changes only what is given; the agent's name is the identity's (`rename`). */
    async change(agentId: string, changes: AgentSetupChanges): Promise<void> {
      await tx.update(s).set({ ...changes, version: sql`${s.version} + 1`, updatedAt: new Date() }).where(eq(s.agentId, agentId));
    },
    async rename(agentId: string, name: string): Promise<void> {
      await tx.update(a).set({ name, updatedAt: new Date() }).where(eq(a.id, agentId));
      await tx.update(k).set({ name, updatedAt: new Date() }).where(and(eq(k.agentId, agentId), eq(k.computeSource, 'owner_assistant')));
    },
    /** Deleting an agent: it stops acting on its next call, its tasks go back to its owner and its memory and its schedules go (nothing fires for an agent that is gone). */
    async remove(ownerUserId: string, agentId: string): Promise<void> {
      await lockAssistantOwner(tx, ownerUserId);
      const now = new Date();
      await tx.update(k).set({ revokedAt: now, updatedAt: now }).where(and(eq(k.agentId, agentId), eq(k.computeSource, 'owner_assistant')));
      await tx.update(a).set({ revokedAt: now, updatedAt: now }).where(eq(a.id, agentId));
      await tx.delete(m).where(eq(m.agentId, agentId));
      // The schedules and their history, Undo window and all: an agent that is gone has nothing to run them (its row stays, revoked, so the cascade does not).
      await tx.delete(schema.assistantJobs).where(eq(schema.assistantJobs.agentId, agentId));
      const w = schema.projectWorkItems;
      await tx.update(w).set({ ownerAgentId: null, ownerUserId, version: sql`${w.version} + 1`, updatedAt: now }).where(and(eq(w.ownerAgentId, agentId), sql`${w.status} <> 'done'`));
    },
    memory: {
      async list(agentId: string): Promise<AgentMemoryItem[]> {
        return (await tx.select().from(m).where(eq(m.agentId, agentId)).orderBy(asc(m.createdAt), asc(m.id)))
          .map((row) => ({ id: row.id, agentId: row.agentId, body: row.body, source: row.source, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
      },
      async count(agentId: string): Promise<number> {
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(m).where(eq(m.agentId, agentId));
        return row?.n ?? 0;
      },
      async add(ownerUserId: string, agentId: string, workspaceId: string, body: string, source: string): Promise<AgentMemoryItem> {
        const [row] = await tx.insert(m).values({ id: randomUUID(), agentId, workspaceId, ownerUserId, body, source }).returning();
        return { id: row!.id, agentId, body: row!.body, source: row!.source, createdAt: row!.createdAt.toISOString(), updatedAt: row!.updatedAt.toISOString() };
      },
      async edit(agentId: string, itemId: string, body: string): Promise<AgentMemoryItem | null> {
        const [row] = await tx.update(m).set({ body, updatedAt: new Date() }).where(and(eq(m.agentId, agentId), eq(m.id, itemId))).returning();
        return row ? { id: row.id, agentId, body: row.body, source: row.source, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } : null;
      },
      async remove(agentId: string, itemId: string): Promise<boolean> {
        return (await tx.delete(m).where(and(eq(m.agentId, agentId), eq(m.id, itemId))).returning({ id: m.id })).length > 0;
      },
    },
  };
}
