import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GITHUB_WEBHOOK_PATH } from '@flux/contracts';
import { githubId, InvalidInputError, type GithubDelivery } from '@flux/core';
import { useDomainErrors } from '../http/commands.js';
const ACTIONS: Record<string, readonly string[]> = {
  pull_request: ['opened', 'edited', 'closed', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'locked', 'unlocked', 'review_requested', 'review_request_removed', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'milestoned', 'demilestoned', 'auto_merge_enabled', 'auto_merge_disabled', 'enqueued', 'dequeued'],
  pull_request_review: ['submitted', 'edited', 'dismissed'], pull_request_review_comment: ['created', 'edited', 'deleted'],
  issue_comment: ['created', 'edited', 'deleted'], check_run: ['created', 'completed'], check_suite: ['completed'],
  installation: ['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'], installation_repositories: ['added', 'removed'],
  github_app_authorization: ['revoked'],
};
const EVENTS = [...Object.keys(ACTIONS), 'status', 'ping'];
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('Invalid webhook object', 'GITHUB_INVALID_EVENT');
  return value as Record<string, unknown>;
};
/** Headers select parsing only; signed body identities are validated independently. Null means a valid but irrelevant event. */
export function parseGithubDelivery(id: string, event: string, raw: Buffer, appId: string): GithubDelivery | null {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id) || !EVENTS.includes(event)) throw new InvalidInputError('Unsupported webhook identity or event', 'GITHUB_INVALID_EVENT');
  let payload: Record<string, unknown>;
  try { payload = obj(JSON.parse(raw.toString('utf8'))); } catch { throw new InvalidInputError('Invalid webhook JSON', 'GITHUB_INVALID_EVENT'); }
  if (ACTIONS[event] && !ACTIONS[event]!.includes(String(payload.action))) throw new InvalidInputError('Unsupported webhook action', 'GITHUB_INVALID_EVENT');
  if (event === 'ping') {
    const hookId = githubId(payload.hook_id);
    if (githubId(obj(payload.hook).id) !== hookId) throw new InvalidInputError('Mismatched webhook ping', 'GITHUB_INVALID_EVENT');
    return { id, appId, digest: createHash('sha256').update(raw).digest('hex'), event, payload, installationId: null, repositoryId: null, providerObjectId: hookId, origin: 'webhook' };
  }
  if (event === 'installation' || event === 'installation_repositories') {
    if (githubId(obj(payload.installation).app_id) !== appId) throw new InvalidInputError('Wrong GitHub App event', 'GITHUB_INVALID_EVENT');
  }
  const special = ['installation', 'installation_repositories', 'github_app_authorization'].includes(event);
  const installationId = event === 'github_app_authorization' ? null : githubId(obj(payload.installation).id);
  const repositoryId = special ? null : githubId(obj(payload.repository).id);
  let providerObjectId: string | null = null;
  if (event === 'github_app_authorization') {
    if (payload.action !== 'revoked') throw new InvalidInputError('Unsupported authorization event', 'GITHUB_INVALID_EVENT');
    providerObjectId = githubId(obj(payload.sender).id);
  } else if (event === 'installation' || event === 'installation_repositories') {
    if (typeof payload.action !== 'string' || !['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted', 'added', 'removed'].includes(payload.action))
      throw new InvalidInputError('Unsupported installation event', 'GITHUB_INVALID_EVENT');
    providerObjectId = installationId;
    if (event === 'installation_repositories') {
      for (const name of ['repositories_added', 'repositories_removed']) {
        if (payload[name] !== undefined && (!Array.isArray(payload[name]) || (payload[name] as unknown[]).length > 1000)) throw new InvalidInputError('Invalid repository selection event');
        for (const repo of (payload[name] as unknown[] | undefined) ?? []) githubId(obj(repo).id);
      }
    }
  } else if (event.startsWith('pull_request')) {
    const pull = obj(payload.pull_request); providerObjectId = githubId(pull.id);
    if (!Number.isSafeInteger(pull.number) || Number(pull.number) < 1 || githubId(obj(obj(pull.base).repo).id) !== repositoryId)
      throw new InvalidInputError('Mismatched pull request identity', 'GITHUB_INVALID_EVENT');
    if (event === 'pull_request_review') providerObjectId = githubId(obj(payload.review).id);
    if (event === 'pull_request_review_comment') providerObjectId = githubId(obj(payload.comment).id);
  } else if (event === 'issue_comment') {
    const issue = obj(payload.issue);
    // The required Issues: read permission also delivers ordinary issue comments; they are acknowledged, never stored.
    if (!issue.pull_request) return null;
    if (!Number.isSafeInteger(issue.number) || Number(issue.number) < 1) throw new InvalidInputError('Only already linked pull request comments are supported', 'GITHUB_INVALID_EVENT');
    providerObjectId = githubId(obj(payload.comment).id);
  } else if (event === 'status') {
    if (!['pending', 'success', 'failure', 'error'].includes(String(payload.state)) || typeof payload.sha !== 'string' || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(payload.sha)) throw new InvalidInputError('Invalid status commit', 'GITHUB_INVALID_EVENT');
    providerObjectId = githubId(payload.id);
  } else {
    const check = obj(payload[event]); providerObjectId = githubId(check.id);
    if (typeof check.head_sha !== 'string' || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(check.head_sha)) throw new InvalidInputError('Invalid check commit', 'GITHUB_INVALID_EVENT');
  }
  return { id, appId, digest: createHash('sha256').update(raw).digest('hex'), event, payload, installationId, repositoryId, providerObjectId, origin: 'webhook' };
}
export async function githubWebhookRoutes(app: FastifyInstance, options: { secret: string; appId: string; admit(delivery: GithubDelivery): Promise<unknown> }) {
  useDomainErrors(app);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.post(GITHUB_WEBHOOK_PATH, async (request, reply) => {
    const raw = request.body;
    const signature = request.headers['x-hub-signature-256']; const id = request.headers['x-github-delivery']; const event = request.headers['x-github-event'];
    if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature) || typeof id !== 'string' || typeof event !== 'string')
      return reply.code(401).send({ code: 'GITHUB_SIGNATURE_INVALID', error: 'Invalid webhook signature' });
    const expected = createHmac('sha256', options.secret).update(raw).digest(); const actual = Buffer.from(signature.slice(7), 'hex');
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ code: 'GITHUB_SIGNATURE_INVALID', error: 'Invalid webhook signature' });
    const delivery = parseGithubDelivery(id, event, raw, options.appId);
    if (!delivery) return reply.code(202).send({ accepted: false });
    await options.admit(delivery);
    return reply.code(202).send({ accepted: true });
  });
}
