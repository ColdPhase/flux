import type { Executor } from '../types.js';
import type { SourceLookup, SourceReadAuthorizer, SourceReadDecision } from '../push/ports.js';
import { evaluateDraft, evaluateProject, evaluateWorkspace } from './policy.js';

/**
 * The access policy as the notification use cases' `SourceReadAuthorizer` port: a person may
 * see a notification only while `<type>.read` on its source is allowed. It uses the same
 * evaluators as `authorize`, reads current rows (no cache) and reports the source's workspace.
 * Pass a transaction to decide inside it.
 */
export function policySourceReader(db: Executor): SourceReadAuthorizer {
  return {
    async canRead(userId: string, source: SourceLookup): Promise<SourceReadDecision> {
      const principal = { id: userId, kind: 'human' as const };
      const evaluation = source.type === 'workspace'
        ? await evaluateWorkspace(principal, 'workspace.read', source.id, db)
        : source.type === 'project'
          ? await evaluateProject(principal, 'project.read', source.id, db)
          : await evaluateDraft(principal, 'draft.read', source.id, db);
      const { visible, allowed } = evaluation;
      return { visible, allowed, workspaceId: visible ? evaluation.actor?.workspaceId ?? null : null };
    },
  };
}
