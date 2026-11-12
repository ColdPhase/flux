import { lockedWorkspacesOfRead, memberFilter, returnRows, sidebarRows, workspaceRepository, accessPorts, type Database, type Transaction } from '@flux/db';
import { createSidebarUseCases, listWorkspaces, recordEvent, type SidebarPorts, type SidebarUnitOfWork } from '@flux/core';
import { eventPorts } from '../events.js';

// Adapters that connect the sidebar's own state (#1250) to the access policy and the Drizzle rows. Core defines the ports; the
// spaces of a person's sidebar are the ones `memberFilter` lets them see (the same filter the Inbox and Home use).

function sidebarPorts(tx: Transaction): SidebarPorts {
  const returns = returnRows(tx);
  return {
    access: {
      async workspaceIds(principal) {
        return (await listWorkspaces(principal, tx, accessPorts)).map((workspace) => workspace.id);
      },
      async readableWorkspaceIds(principal) {
        const locked = lockedWorkspacesOfRead();
        return (await listWorkspaces(principal, tx, accessPorts)).map((workspace) => workspace.id).filter((id) => !locked.has(id));
      },
      async memberProjects(principal, workspaceId) {
        return returns.projectIdsWhere(workspaceId, await memberFilter(principal, workspaceId, 'project', tx));
      },
      async eventWorkspace(principal) {
        const mine = (await listWorkspaces(principal, tx, accessPorts)).map((workspace) => workspace.id);
        const company = await workspaceRepository(tx).company();
        return company && mine.includes(company.id) ? company.id : mine[0] ?? null;
      },
    },
    repository: sidebarRows(tx),
    events: { record: async (principal, workspaceId, kind, objectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, objectId, data); } },
  };
}

/** One transaction per use case. */
export function sidebarUnitOfWork(db: Database): SidebarUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(sidebarPorts(tx))) };
}

/** The sidebar's use cases bound to a connection. */
export const sidebarUseCases = (db: Database) => createSidebarUseCases(sidebarUnitOfWork(db));
