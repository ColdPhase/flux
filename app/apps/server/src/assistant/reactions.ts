import type { FastifyInstance } from 'fastify';
import { ASSISTANT_REACTION_ACTIONS, ASSISTANT_REACTION_EVENTS, assistantReactionDraftPath, assistantReactionPath, assistantReactionsPath, type SaveAssistantReaction } from '@flux/contracts';
import { createAssistantReactions, type AssistantReactionUnitOfWork } from '@flux/core';
import { assistantReactionRows, githubRows, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import type { createGithubUseCases } from '../github/adapters.js';

export function registerAssistantReactionRoutes(app: FastifyInstance, uow: AssistantReactionUnitOfWork, sessions: SessionResolver) {
  const use = createAssistantReactions(uow);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const body = { type: 'object', additionalProperties: false, required: ['projectId', 'event', 'action', 'enabled'], properties: {
    projectId: { type: 'string', format: 'uuid' }, event: { type: 'string', enum: ASSISTANT_REACTION_EVENTS.map((item) => item.id) },
    action: { type: 'string', enum: Object.keys(ASSISTANT_REACTION_ACTIONS) }, enabled: { type: 'boolean' },
    dailyLimit: { type: 'integer', minimum: 1, maximum: 24 }, expectedVersion: { type: 'integer', minimum: 1 }, noteVersion: { type: 'string', maxLength: 64 },
  } } as const;
  type Params = { workspace: string; owner: string; id: string };
  const path = assistantReactionsPath(':workspace', ':owner');
  app.get<{ Params: Params }>(path, async (request, reply) => reply.header('cache-control', 'no-store').send({ items: await use.list(await who(request), request.params.workspace, request.params.owner) }));
  app.get<{ Params: Params }>(`${path}/history`, async (request, reply) => reply.header('cache-control', 'no-store').send({ items: await use.history(await who(request), request.params.workspace, request.params.owner) }));
  app.post<{ Params: Params; Body: SaveAssistantReaction }>(path, { schema: { body } }, async (request, reply) => reply.code(201).send(await use.save(await who(request), request.params.workspace, request.params.owner, null, request.body)));
  app.put<{ Params: Params; Body: SaveAssistantReaction }>(assistantReactionPath(':workspace', ':owner', ':id'), { schema: { body } }, async (request) => use.save(await who(request), request.params.workspace, request.params.owner, request.params.id, request.body));
  app.get<{ Params: { id: string } }>(assistantReactionDraftPath(':id'), async (request, reply) => reply.header('cache-control', 'no-store').send(await use.draft(await who(request), request.params.id)));
}

/** Retained G-1 facts use its existing per-human current repository proof; no project-only/private-fact shortcut. */
export async function authorizeGithubReactionEvents(db: Database, github: ReturnType<typeof createGithubUseCases>) {
  const rows = assistantReactionRows(db);
  for (const event of await rows.proofEvents()) {
    try {
      const links = await github.links({ kind: 'human', id: event.ownerUserId }, event.objectId);
      const ready = links.filter((link) => link.id === event.data?.linkId && link.projectId === event.projectId && link.state === 'current' && link.facts.execution === 'ready_for_review');
      const credential = await rows.credential(event.ownerUserId);
      if (!credential || !ready.length) continue;
      const bindings = [];
      for (const id of [...new Set(ready.map((link) => link.bindingId))]) {
        const binding = await githubRows(db).binding(id);
        if (!binding || binding.state !== 'active') continue;
        bindings.push({ id, generation: binding.authorizationGeneration });
      }
      await rows.saveProof(event.id, { linkId: event.data?.linkId, proof: { owner: event.ownerUserId, generation: credential.generation, bindings },
        pullRequests: ready.map((link) => ({ state: link.facts.state, number: link.facts.number, headSha: link.facts.headSha,
          execution: link.facts.execution, checks: link.facts.checks.map(({ name, state }) => ({ name, state })) })) });
    } catch { await rows.updateEvent(event.id, { state: 'skipped', line: 'Skipped: GitHub access is no longer available', finishedAt: new Date() }); }
  }
}

/** Current G-1 data for a nonce-authenticated run immediately before the worker sends its request. */
export function currentGithubReactionFacts(github: ReturnType<typeof createGithubUseCases>) {
  return async (ownerUserId: string, taskId: string, linkId?: string) => {
    const links = await github.links({ kind: 'human', id: ownerUserId }, taskId);
    const ready = links.filter((link) => (!linkId || link.id === linkId) && link.state === 'current' && link.facts.execution === 'ready_for_review');
    if (!ready.length) throw new Error('No current ready pull request');
    return ready.map((link) => ({ number: link.facts.number, state: link.facts.state, headSha: link.facts.headSha, execution: link.facts.execution, truncated: link.facts.truncated,
      checks: link.facts.checks.map(({ name, state }) => ({ name, state })) }));
  };
}
