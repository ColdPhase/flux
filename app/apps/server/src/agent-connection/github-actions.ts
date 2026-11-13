import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, type AgentJsonValue } from '@flux/contracts';
import { NotFoundError, ServiceUnavailableError } from '@flux/core';
import { assistantChangeRows, type Database, type DbExecutor } from '@flux/db';
import { createGithubUseCasesIn, type Provider } from '../github/adapters.js';
import { workRepository } from '../work/adapters.js';
import { actionAnnotations as annotations, actionId as id, coordinationExecutor } from './action-execution.js';
import { sentArgs } from './ask-first.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/**
 * `flux_link_pull_request` (#160 AC-3): an agent links the pull request it produced to the task it holds, through #74's verified
 * link (TASK_NOT_HELD otherwise). Everyone who reads the task sees the link, and a required output can move the task, so with Ask me
 * first on it waits for the owner's OK (#1419). Nothing is added on the GitHub side: the owner's own GitHub authorization verifies the
 * PR through the read-only App.
 */
export function registerAgentGithubActions(tools: AgentToolRegistry, db: Database, github: Provider | null) {
  tools.forAccess('write', { operation: 'work.update', classes: AGENT_OPERATION_CLASSES['work.update'] }).registerTool('flux_link_pull_request', {
    title: 'Link a pull request to the task you hold',
    description: 'Link the GitHub pull request you produced to the native task you hold, by its URL '
      + '(https://github.com/<owner>/<repository>/pull/<number>). The repository must already be connected to this project by a person; '
      + 'Flux verifies the pull request with your owner\'s own GitHub authorization through its read-only App, exactly as when a person '
      + 'links it, and adds no GitHub permission. You hold the task when your owner or a project member assigned it to you and nobody '
      + 'has stopped or finished it (TASK_NOT_HELD). Needs the runtime from flux_bootstrap. '
      + 'A required output (the default) lets the task\'s GitHub rule, if one is on, '
      + 'move the task from the pull request; a related one never does. Linking the same pull request again returns the same link. '
      + 'GITHUB_REPOSITORY_NOT_BOUND means no person has connected that repository to the project; '
      + 'GITHUB_AUTHORIZATION_REQUIRED means your owner has to authorize GitHub in Flux first.',
    inputSchema: z.strictObject({
      projectId: id,
      runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
      clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
      workId: id.describe('The native task you hold.'),
      pullRequestUrl: z.string().min(1).max(300).describe('The pull request URL, for example https://github.com/acme/firmware/pull/42.'),
      role: z.enum(['required_output', 'related']).default('required_output')
        .describe('required_output: the pull request is what the task needs. related: it only touches the task.'),
    }),
    annotations,
  }, async (sent, { claims }) => {
    const args = sentArgs(sent);
    const { workId, pullRequestUrl, role, ...input } = args;
    try {
      if (!github) throw new ServiceUnavailableError('GitHub App integration is unavailable', 'GITHUB_UNAVAILABLE');
      // Named only when it is a task of this space: what waits is shown to the owner, who can read the space (checked before it waits).
      const task = await assistantChangeRows(db as unknown as DbExecutor).work(workId);
      const named = task?.projectId === input.projectId ? `#${task.number} ${task.title} · ` : '';
      const ask = { tool: 'flux_link_pull_request', args, operation: 'work.update', objectType: 'work' as const, objectId: workId,
        title: `${named}pull request ${pullRequestUrl}` };
      return toolResult(await coordinationExecutor(db, claims, undefined, ask)({ ...input, sources: [] }, 'work.update', workId, { link: { pullRequestUrl, role } } as unknown as AgentJsonValue,
        async ({ transaction, events, agent, runtime }) => {
          // The owner is the server-issued runtime's, never the tool's input.
          const link = await createGithubUseCasesIn(transaction, events, github)
            .linkForAgent(agent, { kind: 'human', id: runtime.ownerUserId }, workId, { pullRequestUrl, role });
          const task = await workRepository(transaction).findWork(workId);
          if (!task) throw new NotFoundError('Work item');
          return { value: { linkId: link.id, workId, bindingId: link.bindingId, role: link.role, number: link.facts.number, url: link.facts.url,
            headSha: link.facts.headSha, pullState: link.facts.state, execution: link.facts.execution, linkState: link.state, version: task.version },
          postconditions: [{ kind: 'work', id: workId, version: task.version }] };
        }));
    } catch (error) { return toolError(error); }
  });
}
