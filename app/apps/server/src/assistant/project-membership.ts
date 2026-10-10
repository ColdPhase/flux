import { lockAssistantOwner, schema } from '@flux/db';
import { eq } from 'drizzle-orm';
import { createProject, getProject, grantProject, isUuid, type Database, type Principal } from '@flux/core';
import type { CreateProjectCommand, GrantProjectCommand } from '@flux/contracts';
import { assistantRows } from './adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';

/** An owner create and enable serialize before either writes, so neither can miss the other's auto-join. */
export function createProjectWithAssistant(principal: Principal, workspaceId: string, command: CreateProjectCommand, db: Database) {
  return db.transaction(async (tx) => {
    await lockAssistantOwner(tx, principal.id);
    const events = transactionEventSession(tx);
    const result = await events.run(async () => {
      const project = await createProject(principal, workspaceId, command, tx, events);
      await assistantRows(tx, events).joinCreatedProject(principal.id, workspaceId, project.id);
      return project;
    });
    await events.flushEvents();
    return result;
  });
}

/** Manager Allow remains the ordinary grant command. It updates the assistant's original project ceiling atomically. */
export function grantProjectWithAssistant(principal: Principal, projectId: string, command: GrantProjectCommand, db: Database) {
  return db.transaction(async (tx) => {
    if (command.principal?.kind === 'agent' && isUuid(command.principal.id)) {
      const [target] = await tx.select({ owner: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, command.principal.id));
      if (target?.owner) await lockAssistantOwner(tx, target.owner);
    }
    const events = transactionEventSession(tx);
    const result = await events.run(async () => {
      const workspaceId = (await getProject(principal, projectId, tx)).workspaceId;
      const grant = await grantProject(principal, projectId, command, tx, events);
      if (command.principal.kind === 'agent' && command.role !== 'denied')
        await assistantRows(tx, events).addGrantedProject(command.principal.id, workspaceId, projectId);
      return grant;
    });
    await events.flushEvents();
    return result;
  });
}
