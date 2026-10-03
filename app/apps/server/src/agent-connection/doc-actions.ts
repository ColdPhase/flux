import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, DOC_LIMITS, type AgentJsonValue, type AgentOperation, type CreateDocCommand, type DocState,
  type UpdateDocCommand } from '@flux/contracts';
import { RuleViolationError, type Database } from '@flux/core';
import { actionAnnotations as annotations, actionId as id, actionInput, actionVersion as version, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const execution = actionInput(['execute', 'plan']);
const title = z.string().min(1).max(DOC_LIMITS.title);
const body = z.string().max(DOC_LIMITS.body).describe('Markdown. [label](flux:<type>/<id>) refers to an object of this project; anything else renders as not available.');
const state = z.enum(['draft', 'published'] as const satisfies readonly DocState[])
  .describe('Draft or published. Both are visible exactly to the project audience; draft is a state, never a private note.');
const reason = z.string().max(DOC_LIMITS.reason).describe('Why this version was made; generated from the change when omitted.');

/**
 * Standing-grant changes to the project wiki through the canonical doc commands (#112), in the same one-transaction
 * executor as the work and map actions. The agent is the real author of every version it saves. A doc is a project
 * object only: private drafts and notes are never a target, a source or a publication path.
 */
export function registerAgentDocActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);
  const grantNote = 'Needs a live standing grant for this operation and the runtime from flux_bootstrap.';

  register('doc.create').registerTool('flux_create_doc', {
    title: 'Start a project wiki doc under a standing grant',
    description: 'Start one project doc (wiki page) as the agent, with a title, Markdown text and a state (draft unless given). '
      + `Everyone with current project access can read it. Cited source revisions must still be current. ${grantNote}`,
    inputSchema: z.strictObject({ ...execution, doc: z.strictObject({ title, body: body.optional(), state: state.optional(), reason: reason.optional() }) }),
    annotations,
  }, ({ doc, ...input }) => run(() => execute(input, 'doc.create', null, doc as unknown as AgentJsonValue, async ({ docs, agent }) => {
    const command: CreateDocCommand = doc;
    const created = await docs.createDoc(agent, input.projectId, command);
    return { value: { docId: created.id, version: created.version, state: created.state },
      postconditions: [{ kind: 'doc', id: created.id, version: created.version }] };
  })));

  register('doc.update').registerTool('flux_update_doc', {
    title: 'Edit a project wiki doc under a standing grant',
    description: 'Save the next version of one project doc at the exact version you last read, like If-Match: a new title, '
      + 'the complete new Markdown text, its state and a reason. Earlier versions are never rewritten. A doc changed since is '
      + 'VERSION_CONFLICT and nothing is saved or debited: read it again with flux_get_doc. A change that alters nothing is '
      + `DOC_UNCHANGED. ${grantNote} A grant can name this doc or the whole project.`,
    inputSchema: z.strictObject({ ...execution, docId: id.describe('A doc of this project, from flux_list_docs.'), expectedVersion: version,
      changes: z.strictObject({ title: title.optional(), body: body.optional(), state: state.optional(), reason: reason.optional() }) }),
    annotations,
  }, ({ docId, expectedVersion, changes, ...input }) => run(() => execute(input, 'doc.update', docId, { expectedVersion, changes } as unknown as AgentJsonValue,
    async ({ docs, agent }) => {
      const command: UpdateDocCommand = changes;
      const updated = await docs.updateDoc(agent, docId, command, expectedVersion);
      // The canonical command saves no version for a change that alters nothing; such a call uses no grant.
      if (updated.version === expectedVersion) throw new RuleViolationError('The change alters nothing; no version was saved', 'DOC_UNCHANGED');
      return { value: { docId: updated.id, version: updated.version, state: updated.state },
        postconditions: [{ kind: 'doc', id: updated.id, version: updated.version }] };
    })));
}
