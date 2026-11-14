import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { projectExportPath, type AgentColour } from '@flux/contracts';
import { schema, type Database, type Executor } from '@flux/db';

// Each agent's colour is part of the agent as every reader gets it (final design §2, #1528): the same agent looks the same to its owner and to
// everyone else, in every view, encrypted spaces included (the colour is not content). The reads name agents in many shapes, a message's author,
// a task's owner or creator, a decision's proposer, a person of a space, an Inbox item's sender, and each one is `{kind: 'agent', id, …}`. The
// colour is filled in here, once, for every `/api/v1` answer, so no read can name an agent without it and a new read gets it too.

/** An agent as an answer names it. */
type AgentRef = { kind: 'agent'; id: string; colour?: AgentColour };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An object of the answer as it will be written out; a Date or another class instance is a value, not something to walk. */
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Every agent named anywhere in `value`. */
function agentsIn(value: unknown, found: AgentRef[]): AgentRef[] {
  if (Array.isArray(value)) for (const item of value) agentsIn(item, found);
  else if (plainObject(value)) {
    if (value.kind === 'agent' && typeof value.id === 'string' && UUID.test(value.id)) found.push(value as AgentRef);
    for (const key in value) {
      const item = value[key];
      if (typeof item === 'object' && item !== null) agentsIn(item, found);
    }
  }
  return found;
}

/** The colours of these agents; an agent without a colour of its own (a local client's identity) is not in it. */
export async function agentColours(db: Executor, ids: Iterable<string>): Promise<Map<string, AgentColour>> {
  const unique = [...new Set(ids)].filter((id) => UUID.test(id));
  if (!unique.length) return new Map();
  const s = schema.assistantSettings;
  const rows = await db.select({ id: s.agentId, colour: s.colour }).from(s).where(inArray(s.agentId, unique));
  return new Map(rows.map((row) => [row.id, row.colour]));
}

/** Gives each agent in `value` its colour, in place. */
export async function withAgentColours<T>(db: Executor, value: T): Promise<T> {
  const agents = agentsIn(value, []);
  if (!agents.length) return value;
  const colours = await agentColours(db, agents.map((agent) => agent.id));
  for (const agent of agents) {
    const colour = colours.get(agent.id);
    if (colour) agent.colour = colour;
  }
  return value;
}

/**
 * Every `/api/v1` answer names its agents with their colours. Registered before any route, so every route has it. The project export is a
 * document of its own format (docs/operations/export.md), not a view, and stays as it is.
 */
export function useAgentColours(app: FastifyInstance, db: Database) {
  const exportRoute = projectExportPath(':projectId');
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (!payload || typeof payload !== 'object' || !request.url.startsWith('/api/v1/') || request.routeOptions.url === exportRoute) return payload;
    return withAgentColours(db, payload);
  });
}
