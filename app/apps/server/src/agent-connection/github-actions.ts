import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, type AgentJsonValue } from '@flux/contracts';
import { NotFoundError, ServiceUnavailableError } from '@flux/core';
import type { Database } from '@flux/db';
import { createGithubUseCasesIn, type Provider } from '../github/adapters.js';
import { workRepository } from '../work/adapters.js';
import { actionAnnotations as annotations, actionId as id, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/**
 * `flux_link_pull_request` (#160 AC-3): an agent links the pull request it produced to the task it holds, through #74's verified
 * link. It is a change to the task, so it needs the same standing grant as `flux_update_task` (`work.update`, for this task or the
 * project). Nothing is added on the GitHub side: the owner's own GitHub authorization verifies the PR through the read-only App.
 */
export function registerAgentGithubActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims, github: Provider | null) {
  const execute = nativeActionExecutor(db, claims);
  tools.forScope('flux.action.execute', { operation: 'work.update', classes: AGENT_OPERATION_CLASSES['work.update'] }).registerTool('flux_link_pull_request', {
    title: 'Link a pull request to the task you hold under a standing grant',
    description: 'Link the GitHub pull request you produced to the native task you hold, by its URL '
      + '(https://github.com/<owner>/<repository>/pull/<number>). The repository must already be connected to this project by a person; '
      + 'Flux verifies the pull request with your owner\'s own GitHub authorization through its read-only App, exactly as when a person '
      + 'links it, and adds no GitHub permission. You hold the task when your owner or a project member assigned it to you and nobody '
      + 'has stopped, paused, parked or finished it (TASK_NOT_HELD, COWORK_PAUSED). Needs a live work.update grant for this task '
      + 'or project and the runtime from flux_bootstrap. A required output (the default) lets the task\'s GitHub rule, if one is on, '
      + 'move the task from the pull request; a related one never does. Linking the same pull request again returns the same link. '
      + 'GITHUB_REPOSITORY_NOT_BOUND means no person has connected that repository to the project; '
      + 'GITHUB_AUTHORIZATION_REQUIRED means your owner has to authorize GitHub in Flux first.',
    inputSchema: z.strictObject({
      projectId: id,
      runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
      grantId: id.describe('A live work.update standing grant from flux_bootstrap for this task or project.'),
      clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
      peerRequestClass: z.enum(AGENT_OPERATION_CLASSES['work.update'] as readonly ['execute', 'plan']).describe('The class of the standing grant being used.'),
      workId: id.describe('The native task you hold.'),
      pullRequestUrl: z.string().min(1).max(300).describe('The pull request URL, for example https://github.com/acme/firmware/pull/42.'),
      role: z.enum(['required_output', 'related']).default('required_output')
        .describe('required_output: the pull request is what the task needs. related: it only touches the task.'),
    }),
    annotations,
  }, async ({ workId, pullRequestUrl, role, ...input }) => {
    try {
      if (!github) throw new ServiceUnavailableError('GitHub App integration is unavailable', 'GITHUB_UNAVAILABLE');
      return toolResult(await execute({ ...input, sources: [] }, 'work.update', workId, { link: { pullRequestUrl, role } } as unknown as AgentJsonValue,
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
