import type { Principal } from '../principal.js';
import type { SketchAccess } from '../sketches/ports.js';
import { ConflictError, RuleViolationError } from './errors.js';
import { dmClosedFor, enforce, lockDmParticipants, lockPromotionScope, evaluateDm, evaluateDraft, evaluateProject, evaluateSketch, evaluateWorkspace } from './policy.js';
import type { AccessReader } from './ports.js';

const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'They';

/**
 * The #107 answer for a 1:1 whose other person is gone: nothing is sketched or copied on their
 * behalf, and only they can reopen it by messaging the caller.
 */
async function requireOpen(access: AccessReader, dmId: string, selfId: string) {
  const closed = await dmClosedFor(access, dmId, selfId);
  if (!closed) return;
  const who = firstName(closed.recipient.name);
  const error = closed.reason === 'left'
    ? new ConflictError(`${who} left this conversation. They can reopen it by messaging you.`, 'DM_RECIPIENT_LEFT')
    : new ConflictError(`${who} is no longer in this workspace, so this conversation has nobody to share with.`, 'DM_RECIPIENT_UNAVAILABLE');
  error.details = { recipient: closed.recipient };
  throw error;
}

/**
 * The access policy as the sketch use cases' `SketchAccess` port (issue #69). It uses the same
 * evaluators as `authorize` and reads current rows on every call. Pass a reader bound to the unit of
 * work's transaction so `lock` holds until it commits.
 */
export function policySketchAccess(access: AccessReader): SketchAccess {
  return {
    async requireSketch(principal, action, sketchId, options) {
      const write = await evaluateSketch(principal, 'sketch.write', sketchId, access, { lock: options?.lock });
      // Visible sketches remain readable even when writing is denied (viewer or closed DM).
      enforce(action === 'sketch.read' ? { ...write, allowed: write.visible } : write, 'sketch');
      return write.allowed ? 'write' : 'read';
    },

    async accessOf(principal, sketchId) {
      const write = await evaluateSketch(principal, 'sketch.write', sketchId, access);
      if (!write.visible) return null;
      return write.allowed ? 'write' : 'read';
    },

    async requireWorkspace(principal: Principal, workspaceId: string) {
      enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, access), 'workspace');
    },

    async requireCreate(principal, target) {
      if (target.scope === 'project') {
        const { project } = enforce(await evaluateProject(principal, 'project.write', target.projectId, access, { lock: true }), 'project');
        // A project the caller can see in another workspace is still not a place in this one.
        if (project!.workspaceId !== target.workspaceId) throw new RuleViolationError('The project belongs to another workspace', 'CROSS_WORKSPACE');
        return;
      }
      if (target.scope === 'dm') {
        // Only a current participant starts a sketch in a DM (#96); invisible DMs answer 404.
        const { dm } = enforce(await evaluateDm(principal, 'dm.write', target.dmId, access, { lock: true }), 'dm');
        if (dm!.workspaceId !== target.workspaceId) throw new RuleViolationError('The direct message belongs to another workspace', 'CROSS_WORKSPACE');
        await requireOpen(access, dm!.id, principal.id);
        return;
      }
      // A private sketch belongs to the person creating it; agents cannot own one.
      enforce(await evaluateWorkspace(principal, 'sketch.create', target.workspaceId, access, { lock: true }), 'workspace');
    },

    async lockPromotion(sketchId, projectId) {
      await lockPromotionScope(access, sketchId, projectId);
    },

    async lockParticipants(dmId) {
      return lockDmParticipants(access, dmId);
    },

    async requireDmOpen(principal, dmId) {
      await requireOpen(access, dmId, principal.id);
    },

    async placement(principal, ref) {
      const evaluation = await evaluateDraft(principal, 'draft.read', ref.id, access, { lock: true });
      if (!evaluation.visible || !evaluation.allowed || !evaluation.draft) return { readable: false, workspaceId: null, title: null };
      return { readable: true, workspaceId: evaluation.draft.workspaceId, title: evaluation.draft.title };
    },
  };
}
