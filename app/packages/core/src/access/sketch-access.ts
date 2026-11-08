import type { Principal } from '../principal.js';
import type { SketchAccess } from '../sketches/ports.js';
import { RuleViolationError } from './errors.js';
import { enforce, evaluateDraft, evaluateProject, evaluateSketch, evaluateWorkspace } from './policy.js';
import type { AccessReader } from './ports.js';

/**
 * The access policy as the sketch use cases' `SketchAccess` port (issue #69). It uses the same
 * evaluators as `authorize` and reads current rows on every call. Pass a reader bound to the unit of
 * work's transaction so `lock` holds until it commits.
 */
export function policySketchAccess(access: AccessReader): SketchAccess {
  return {
    async requireSketch(principal, action, sketchId, options) {
      const write = await evaluateSketch(principal, 'sketch.write', sketchId, access, { lock: options?.lock });
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
        if (project!.workspaceId !== target.workspaceId) throw new RuleViolationError('The space belongs to another company', 'CROSS_WORKSPACE');
        return;
      }
      // A private sketch belongs to the person creating it; agents cannot own one.
      enforce(await evaluateWorkspace(principal, 'sketch.create', target.workspaceId, access, { lock: true }), 'workspace');
    },

    async placement(principal, ref) {
      const evaluation = await evaluateDraft(principal, 'draft.read', ref.id, access, { lock: true });
      if (!evaluation.visible || !evaluation.allowed || !evaluation.draft) return { readable: false, workspaceId: null, title: null };
      return { readable: true, workspaceId: evaluation.draft.workspaceId, title: evaluation.draft.title };
    },
  };
}
