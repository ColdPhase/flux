import type { DmAccess } from '../direct-messages/ports.js';
import { enforce, evaluateDm, evaluateWorkspace } from './policy.js';
import type { AccessReader } from './ports.js';

/**
 * The access policy as the direct-message use cases' `DmAccess` port (issue #107). It uses the
 * same evaluators as `authorize` and reads current rows on every call. Pass a reader bound to the unit
 * of work's transaction so `lock` holds until it commits.
 */
export function policyDmAccess(access: AccessReader): DmAccess {
  return {
    async requireDm(principal, action, dmId, options) {
      enforce(await evaluateDm(principal, action, dmId, access, { lock: options?.lock }), 'dm');
    },

    async requireWorkspace(principal, workspaceId) {
      enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, access), 'workspace');
    },

    async requireCreate(principal, workspaceId) {
      enforce(await evaluateWorkspace(principal, 'dm.create', workspaceId, access, { lock: true }), 'workspace');
    },

    async activePeople(workspaceId, userIds) {
      const active = new Set<string>();
      // Locks each membership FOR SHARE, so a concurrent removal waits until the DM is created.
      for (const id of [...userIds].sort()) {
        if ((await access.loadActor({ kind: 'human', id }, workspaceId, { lock: true })).active) active.add(id);
      }
      return active;
    },
  };
}
