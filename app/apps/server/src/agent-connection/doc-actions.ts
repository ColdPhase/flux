import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, DOC_LIMITS, type AgentJsonValue, type AgentOperation } from '@flux/contracts';
import { assistantChangeRows, type DbExecutor, type Database, type Transaction } from '@flux/db';
import { RuleViolationError } from '@flux/core';
import { actionAnnotations as annotations, actionId as id, actionInput, actionVersion as version, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const execution = actionInput();
const title = z.string().min(1).max(DOC_LIMITS.title);
const body = z.string().max(DOC_LIMITS.body).describe('Markdown. [label](flux:<type>/<id>) refers to an object of this project; anything else renders as not available.');
const reason = z.string().max(DOC_LIMITS.reason).describe('Why this version was made; generated from the change when omitted.');

/**
 * Changes to the project wiki through the canonical doc commands (#112), in the same one-transaction
 * executor as the work and map actions. The agent is the real author of every version it saves. A doc is a project
 * object only: private drafts and notes are never a target, a source or a publication path.
 */
export function registerAgentDocActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  /** An assistant's version says whose request it was: "Asked by Ada: …" (F-027 AST-6 "Versioned"). An agent's reason is its own words. */
  const reasoned = async (tx: Transaction, ownerUserId: string, given: string | undefined, fallback: string) => {
    if (!claims.run && !claims.approval?.runId) return given;
    const name = (await assistantChangeRows(tx as DbExecutor).names([ownerUserId])).get(ownerUserId) ?? 'their owner';
    return `Asked by ${name}: ${given?.trim() || fallback}`.slice(0, DOC_LIMITS.reason);
  };
  const register = (operation: AgentOperation) => tools.forAccess('write', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);

  register('doc.create').registerTool('flux_create_doc', {
    title: 'Start a project wiki doc',
    description: 'Start one project doc (wiki page) as the agent, with a title and Markdown text. '
      + `Everyone with current project access can read it. Cited source revisions must still be current.`,
    inputSchema: z.strictObject({ ...execution, doc: z.strictObject({ title, body: body.optional(), reason: reason.optional() }) }),
    annotations,
  }, ({ doc, ...input }) => run(() => execute(input, 'doc.create', null, doc as unknown as AgentJsonValue, async ({ docs, agent, transaction, runtime }) => {
    const { reason: given, ...command } = doc;
    const created = await docs.createDoc(agent, input.projectId, command, await reasoned(transaction, runtime.ownerUserId, given, 'started by their assistant'));
    return { value: { docId: created.id, version: created.version },
      postconditions: [{ kind: 'doc', id: created.id, version: created.version }] };
  })));

  register('doc.update').registerTool('flux_update_doc', {
    title: 'Edit a project wiki doc',
    description: 'Save the next version of one project doc at the exact version you last read, like If-Match: a new title, '
      + 'the complete new Markdown text and a reason. Earlier versions are never rewritten. A doc changed since is '
      + 'VERSION_CONFLICT and nothing is saved: read it again with flux_get_doc. A change that alters nothing is '
      + 'DOC_UNCHANGED.',
    inputSchema: z.strictObject({ ...execution, docId: id.describe('A doc of this project, from flux_list_docs.'), expectedVersion: version,
      changes: z.strictObject({ title: title.optional(), body: body.optional(), reason: reason.optional() }) }),
    annotations,
  }, ({ docId, expectedVersion, changes, ...input }) => run(() => execute(input, 'doc.update', docId, { expectedVersion, changes } as unknown as AgentJsonValue,
    async ({ docs, agent, transaction, runtime }) => {
      const { reason: given, ...command } = changes;
      const updated = await docs.updateDoc(agent, docId, command, expectedVersion, await reasoned(transaction, runtime.ownerUserId, given, 'edited by their assistant'));
      // The canonical command saves no version for a change that alters nothing; such a call changes nothing.
      if (updated.version === expectedVersion) throw new RuleViolationError('The change alters nothing; no version was saved', 'DOC_UNCHANGED');
      return { value: { docId: updated.id, version: updated.version },
        postconditions: [{ kind: 'doc', id: updated.id, version: updated.version }] };
    })));

  register('doc.delete').registerTool('flux_delete_doc', {
    title: 'Delete a project wiki doc',
    description: 'Ask to delete one project doc (wiki page) for everyone with access, at the version you last read, like If-Match. Deleting always '
      + 'waits for your owner\'s OK: the page stays until they approve, and then nothing of it remains. A message that cited it says the page was '
      + 'deleted. A doc changed since is VERSION_CONFLICT and nothing is deleted: read it again with flux_get_doc.',
    inputSchema: z.strictObject({ ...execution, docId: id.describe('A doc of this project, from flux_list_docs.'), expectedVersion: version }),
    annotations: { ...annotations, destructiveHint: true },
  }, ({ docId, expectedVersion, ...input }) => run(() => execute(input, 'doc.delete', docId, { expectedVersion } as unknown as AgentJsonValue,
    async ({ docs, agent }) => {
      await docs.deleteDoc(agent, docId, expectedVersion);
      return { value: { docId, deleted: true }, postconditions: [{ kind: 'doc_removed', id: docId }] };
    })));
}
