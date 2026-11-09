import { FIRST_AGENT_NAME, type CreateMyAgentCommand, type MyAgent } from '@flux/contracts';
import { createAgent, DomainError, InvalidInputError, type Principal } from '@flux/core';
import { accessPorts, agentTaskRows, assistantJobRows, lockAssistantOwner, type Database } from '@flux/db';
import { workUseCases } from '../work/adapters.js';
import { personalRunUseCases, type PersonalRunComposition } from './adapters.js';

/**
 * Makes one of the caller's agents in the caller's transaction (F-036 AG-1): its identity and its setup together or not at all. With
 * `agentId` the identity already exists and only the setup is made; otherwise a new identity is made in `workspaceId`, called
 * `name`, or Assistant when it is the caller's first. The caller's lock comes first, so two requests at once (two tabs, two
 * connections) cannot both find no agent and each make one.
 */
export async function makeAgent(tx: Database, composition: PersonalRunComposition, actor: Principal, body: CreateMyAgentCommand): Promise<MyAgent> {
  if (actor.id) await lockAssistantOwner(tx, actor.id);
  const uses = personalRunUseCases(tx, composition);
  let agentId = body.agentId;
  if (!agentId) {
    if (!body.workspaceId) throw new InvalidInputError('workspaceId is required for a new agent');
    const first = (await uses.listAgents(actor)).length === 0;
    const name = body.name ?? (first ? FIRST_AGENT_NAME : null);
    if (!name) throw new InvalidInputError('Name the new agent');
    agentId = (await createAgent(actor, body.workspaceId, { name, owner: 'self' }, tx, accessPorts)).id;
  }
  return uses.enable(actor, { ...body, agentId });
}

/**
 * Deletes one of the caller's agents in the caller's transaction (F-036 AG-1). The tasks it holds go back to the caller through the work
 * use case, as when an agent hands one back: each has its history row and its live update, and a run still working on one is stopped.
 * A task that could not be given back that way is returned by the deletion itself, so none stays with a deleted agent.
 */
export async function removeAgent(tx: Database, composition: PersonalRunComposition, actor: Principal, agentId: string): Promise<void> {
  // Anything that is not an id is for the deletion to answer "not found".
  if (actor.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    // The agent's schedules before the owner's lock, as a firing takes them (a firing holds its schedule row and then takes the owner's lock): two
    // transactions that need both never wait on each other.
    await assistantJobRows(tx).lockForAgent(actor.id, agentId.toLowerCase());
    await lockAssistantOwner(tx, actor.id);
    for (const held of await agentTaskRows(tx).heldBy(agentId.toLowerCase(), actor.id)) {
      try {
        await workUseCases(tx).updateWork(actor, held.id, { owner: { kind: 'human', id: actor.id } }, held.version, 'agent_deleted');
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    }
  }
  await personalRunUseCases(tx, composition).remove(actor, agentId);
}

/**
 * Connecting AI the first time gives a person Assistant (F-036 AG-1): called after a person's key is saved or their Claude or
 * ChatGPT plan is signed in. Once per person: someone who has had an agent, and deleted it, is not given one again. It makes
 * nothing for a guest (who has no AI) or when no model can be chosen yet, and it never fails the connection that called it.
 */
export function firstAgentMaker(db: Database, composition: PersonalRunComposition, log: { warn(object: unknown, message: string): void } = { warn: () => undefined }) {
  return async (ownerUserId: string): Promise<void> => {
    const actor: Principal = { kind: 'human', id: ownerUserId };
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await lockAssistantOwner(scoped, ownerUserId);
        if (await personalRunUseCases(scoped, composition).hadAnAgent(actor)) return;
        // The workspace the app shows as the person's own (the company, else the oldest they are in), and the same rule for a guest of it as
        // the page's: a guest has no AI, whatever other workspace they are in (#959).
        const places = await accessPorts.workspaces(scoped).forMember(ownerUserId);
        const home = places.find((place) => place.workspace.company) ?? places[0];
        if (!home || home.role === 'guest') return;
        await makeAgent(scoped, composition, actor, { workspaceId: home.workspace.id });
      });
    } catch (error) {
      // A rule's refusal (a guest, no connection to choose a model on yet) means there is nothing to make now; anything else is logged.
      if (!(error instanceof DomainError)) log.warn({ error }, 'The first agent could not be made');
    }
  };
}
