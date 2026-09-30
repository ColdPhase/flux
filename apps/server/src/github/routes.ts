import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { githubRows } from '@flux/db';
import { GITHUB_CALLBACK_PATH, type GithubCapabilities } from '@flux/contracts';
import { assertAuthorized, DomainError, githubId, InvalidInputError, ServiceUnavailableError, type Database, type GithubProvider } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { githubCredentials } from './credentials.js';
import type { GithubConfig } from './config.js';
import { githubProvider } from './provider.js';
import { githubOauth } from './oauth.js';
import { githubTransport, type GithubTransport } from './http.js';
import { createGithubUseCases } from './adapters.js';
import { githubWebhookRoutes } from './webhook.js';
interface Options { db: Database; sessions: SessionResolver; config: GithubConfig | null; transport?: GithubTransport; provider?: GithubProvider; background?: boolean }
const bindBody = { type: 'object', additionalProperties: false, required: ['installationId', 'repositoryId'], properties: { installationId: { type: 'string', pattern: '^[1-9][0-9]{0,24}$' }, repositoryId: { type: 'string', pattern: '^[1-9][0-9]{0,24}$' } } } as const;
const linkBody = { type: 'object', additionalProperties: false, required: ['bindingId', 'number', 'role'], properties: { bindingId: { type: 'string', format: 'uuid' }, number: { type: 'integer', minimum: 1 }, role: { type: 'string', enum: ['required_output', 'related'] } } } as const;
export async function githubRoutes(app: FastifyInstance, options: Options) {
  useDomainErrors(app);
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer'); return payload; });
  const { db, sessions, config } = options; const transport = options.transport ?? githubTransport();
  const credentials = config ? githubCredentials(db, config, transport) : null;
  const provider = config ? githubProvider(credentials!, config, transport) : null;
  const useCases = config ? createGithubUseCases(db, options.provider ?? provider!) : null;
  const oauth = config ? githubOauth(db, config, credentials!, transport) : null;
  const unavailable = () => { if (!config) throw new ServiceUnavailableError('GitHub App integration is unavailable', 'GITHUB_UNAVAILABLE'); };
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  async function project(request: Parameters<SessionResolver['requirePrincipal']>[0], id: string, manage = false) {
    const actor = await principal(request); await assertAuthorized(actor, manage ? 'project.manage' : 'project.read', { type: 'project', id }, db); return actor;
  }
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/github/capabilities', async (request): Promise<GithubCapabilities> => {
    const actor = await project(request, request.params.projectId);
    return { status: config ? 'configured' : 'unavailable', authorization: credentials ? await credentials.state(actor.id) : 'required', taskAutomation: 'unavailable', agentDelivery: 'unavailable' };
  });
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/github/authorize', async (request) => {
    unavailable(); return oauth!.start(await sessions.requirePrincipal(request), request.params.projectId, 'authorize');
  });
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/github/install', async (request) => {
    unavailable(); return oauth!.start(await sessions.requirePrincipal(request), request.params.projectId, 'install');
  });
  app.get(GITHUB_CALLBACK_PATH, { logLevel: 'silent' }, async (request, reply) => {
    unavailable(); const url = new URL(request.url, config!.publicOrigin);
    for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new InvalidInputError('Ambiguous callback query', 'GITHUB_FLOW_INVALID');
    if (url.searchParams.has('error')) throw new InvalidInputError('GitHub authorization was not completed', 'GITHUB_AUTHORIZATION_DENIED');
    const session = await sessions.requirePrincipal(request);
    const result = await oauth!.callback(session, { state: url.searchParams.get('state') ?? undefined, code: url.searchParams.get('code') ?? undefined, installation_id: url.searchParams.get('installation_id') ?? undefined });
    if (result.installationId && !(await provider!.installations(session.principal)).some((row) => row.id === githubId(result.installationId)))
      throw new InvalidInputError('Installation is not accessible', 'GITHUB_ACCESS_UNAVAILABLE');
    return reply.redirect(`${config!.publicOrigin}/projects/${result.projectId}/github`);
  });
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/github/installations', async (request) => {
    unavailable(); return provider!.installations(await project(request, request.params.projectId, true));
  });
  app.get<{ Params: { projectId: string; installationId: string }; Querystring: { page?: string } }>('/api/v1/projects/:projectId/github/installations/:installationId/repositories', async (request) => {
    unavailable(); return provider!.repositories(await project(request, request.params.projectId, true), request.params.installationId, request.query.page === undefined ? 1 : Number(request.query.page));
  });
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/github/bindings', async (request) => {
    unavailable(); return useCases!.bindings(await principal(request), request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: { installationId: string; repositoryId: string } }>('/api/v1/projects/:projectId/github/bindings', { schema: { body: bindBody } }, async (request, reply) => {
    unavailable(); return reply.code(201).send(await useCases!.bind(await principal(request), request.params.projectId, request.body));
  });
  app.delete<{ Params: { bindingId: string } }>('/api/v1/github/bindings/:bindingId', async (request, reply) => {
    unavailable(); await useCases!.disconnect(await principal(request), request.params.bindingId); return reply.code(204).send();
  });
  app.delete('/api/v1/github/authorization', async (request, reply) => {
    unavailable(); await credentials!.revoke((await principal(request)).id); return reply.code(204).send();
  });
  app.get<{ Params: { taskId: string } }>('/api/v1/work/:taskId/github-links', async (request) => {
    unavailable(); return useCases!.links(await principal(request), request.params.taskId);
  });
  app.post<{ Params: { taskId: string }; Body: { bindingId: string; number: number; role: 'required_output' | 'related' } }>('/api/v1/work/:taskId/github-links', { schema: { body: linkBody } }, async (request, reply) => {
    unavailable(); return reply.code(201).send(await useCases!.link(await principal(request), request.params.taskId, request.body));
  });
  app.post<{ Params: { bindingId: string } }>('/api/v1/github/bindings/:bindingId/reconcile', async (request, reply) => {
    unavailable(); const actor = await principal(request); const binding = await githubRows(db).binding(request.params.bindingId);
    if (!binding) throw new InvalidInputError('Binding is unavailable');
    await assertAuthorized(actor, 'project.manage', { type: 'project', id: binding.projectId }, db);
    await provider!.repository(actor, binding.installationId, binding.repositoryId);
    const id = `reconcile-${randomUUID()}`;
    await useCases!.admit({ id, appId: config!.appId, event: 'reconcile', digest: createHash('sha256').update(id).digest('hex'), payload: {},
      repositoryId: binding.repositoryId, installationId: binding.installationId, providerObjectId: null, origin: 'reconcile' });
    return reply.code(202).send({ pending: true });
  });
  if (!config) return;
  await app.register(githubWebhookRoutes, { secret: config.webhookSecret, appId: config.appId, admit: useCases!.admit });
  if (options.background === false) return;
  let running = false; let inFlight: Promise<void> | null = null;
  const sweep = async () => {
    if (running) return; running = true;
    try {
      for (const row of await githubRows(db).due(5)) {
        try { await useCases!.process(row.deliveryId, row.bindingId); }
        catch (error) { await githubRows(db).failed(row.deliveryId, row.bindingId, error instanceof DomainError ? error.code : 'GITHUB_UNAVAILABLE'); }
      }
      await githubRows(db).prune();
    } catch { app.log.warn('GitHub inbox processing is unavailable'); }
    finally { running = false; }
  };
  const startSweep = () => { if (!running) inFlight = sweep(); };
  const timer = setInterval(startSweep, 10_000); timer.unref();
  app.addHook('onReady', async () => { startSweep(); });
  app.addHook('onClose', async () => { clearInterval(timer); await inFlight; });
}
