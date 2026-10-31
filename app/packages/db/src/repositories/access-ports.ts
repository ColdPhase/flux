import { accessReader } from './access.js';
import { agentRepository } from './agents.js';
import { draftRepository } from './drafts.js';
import { eventRepository } from './events.js';
import { projectRepository } from './projects.js';
import { workspaceAiSweepRows } from './workspace-ai.js';
import { workspaceEncryptionRows } from './workspace-encryption.js';
import { workspaceInviteRepository } from './workspace-invites.js';
import { workspaceRepository } from './workspaces.js';

/**
 * The persistence ports of the access use cases (issues #46, #91), as core's `AccessPorts` declares them. Pass it
 * after the database handle: `addMember(principal, workspaceId, command, db, accessPorts)`. Each member binds one
 * repository to the transaction or connection a step runs in, so every statement of a use case shares its
 * transaction and its locks. This package cannot import core (core still depends on it, #92), so core's port
 * types are satisfied structurally; `tests/app/access-use-cases.test.ts` assigns this object to `AccessPorts`, and
 * a mismatch fails to compile there and at each call site.
 */
export const accessPorts = {
  workspaces: workspaceRepository,
  invites: workspaceInviteRepository,
  projects: projectRepository,
  agents: agentRepository,
  drafts: draftRepository,
  encryption: workspaceEncryptionRows,
  aiSweep: workspaceAiSweepRows,
  access: accessReader,
  events: eventRepository,
};
