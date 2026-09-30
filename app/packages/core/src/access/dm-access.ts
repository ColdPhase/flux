import type { DmAccess } from '../direct-messages/ports.js';
import type { Executor } from '../types.js';
import { enforce, evaluateDm, evaluateWorkspace, loadActor } from './policy.js';

/**
 * The access policy as the direct-message use cases' `DmAccess` port (issue #107). It uses the
 * same evaluators as `authorize` and reads current rows on every call. Pass the unit of work's
 * transaction so `lock` holds until it commits.
 */
export function policyDmAccess(db: Executor): DmAccess {
  return {
    async requireDm(principal, action, dmId, options) {
      enforce(await evaluateDm(principal, action, dmId, db, { lock: options?.lock }), 'dm');
    },

    async requireWorkspace(principal, workspaceId) {
      enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, db), 'workspace');
    },

    async requireCreate(principal, workspaceId) {
      enforce(await evaluateWorkspace(principal, 'dm.create', workspaceId, db, { lock: true }), 'workspace');
    },

    async activePeople(workspaceId, userIds) {
      const active = new Set<string>();
      // Locks each membership FOR SHARE, so a concurrent removal waits until the DM is created.
      for (const id of [...userIds].sort()) {
        if ((await loadActor({ kind: 'human', id }, workspaceId, db, { lock: true })).active) active.add(id);
      }
      return active;
    },
  };
}
