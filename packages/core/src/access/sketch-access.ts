import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Executor, Principal } from '../types.js';
import type { SketchAccess } from '../sketches/ports.js';
import { RuleViolationError } from './errors.js';
import { enforce, evaluateDraft, evaluateProject, evaluateSketch, evaluateWorkspace } from './policy.js';

/**
 * The access policy as the sketch use cases' `SketchAccess` port (issue #69). It uses the same
 * evaluators as `authorize` and reads current rows on every call. Pass the unit of work's
 * transaction so `lock` holds until it commits.
 */
export function policySketchAccess(db: Executor): SketchAccess {
  return {
    async requireSketch(principal, action, sketchId, options) {
      enforce(await evaluateSketch(principal, action, sketchId, db, { lock: options?.lock }), 'sketch');
      if (action === 'sketch.write') return 'write';
      return (await evaluateSketch(principal, 'sketch.write', sketchId, db)).allowed ? 'write' : 'read';
    },

    async accessOf(principal, sketchId) {
      const write = await evaluateSketch(principal, 'sketch.write', sketchId, db);
      if (!write.visible) return null;
      return write.allowed ? 'write' : 'read';
    },

    async requireWorkspace(principal: Principal, workspaceId: string) {
      enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, db), 'workspace');
    },

    async requireCreate(principal, target) {
      if (target.scope === 'project') {
        const { project } = enforce(await evaluateProject(principal, 'project.write', target.projectId, db, { lock: true }), 'project');
        // A project the caller can see in another workspace is still not a place in this one.
        if (project!.workspaceId !== target.workspaceId) throw new RuleViolationError('The project belongs to another workspace', 'CROSS_WORKSPACE');
        return;
      }
      enforce(await evaluateWorkspace(principal, 'sketch.create', target.workspaceId, db, { lock: true }), 'workspace');
      if (!target.participantIds.length) throw new RuleViolationError('A direct sketch needs at least one participant', 'NO_PARTICIPANTS');
      const members = await db.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, target.workspaceId), inArray(schema.workspaceMembers.userId, target.participantIds)))
        .for('share');
      if (members.length !== target.participantIds.length) {
        throw new RuleViolationError('Every participant must be a member of the sketch’s workspace', 'PARTICIPANT_NOT_MEMBER');
      }
    },

    async placement(principal, ref) {
      const evaluation = await evaluateDraft(principal, 'draft.read', ref.id, db);
      if (!evaluation.visible || !evaluation.allowed || !evaluation.draft) return { readable: false, workspaceId: null, title: null };
      return { readable: true, workspaceId: evaluation.draft.workspaceId, title: evaluation.draft.title };
    },
  };
}
