import { FIRST_AGENT_NAME, type CreateMyAgentCommand, type MyAgent } from '@flux/contracts';
import { createAgent, DomainError, InvalidInputError, type Principal } from '@flux/core';
import { accessPorts, type Database } from '@flux/db';
import { personalRunUseCases, type PersonalRunComposition } from './adapters.js';

/**
 * Makes one of the caller's agents in the caller's transaction (F-036 AG-1): its identity and its setup together or not at all. With
 * `agentId` the identity already exists and only the setup is made; otherwise a new identity is made in `workspaceId`, called
 * `name`, or Assistant when it is the caller's first.
 */
export async function makeAgent(tx: Database, composition: PersonalRunComposition, actor: Principal, body: CreateMyAgentCommand): Promise<MyAgent> {
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
        if (await personalRunUseCases(scoped, composition).hadAnAgent(actor)) return;
        // The person's own workspace, the oldest where they are not a guest: the company on a Flux with one company.
        const home = (await accessPorts.workspaces(scoped).forMember(ownerUserId)).find((place) => place.role !== 'guest');
        if (!home) return;
        await makeAgent(scoped, composition, actor, { workspaceId: home.workspace.id });
      });
    } catch (error) {
      // A rule's refusal (a guest, no connection to choose a model on yet) means there is nothing to make now; anything else is logged.
      if (!(error instanceof DomainError)) log.warn({ error }, 'The first agent could not be made');
    }
  };
}
