import { createHash, randomUUID } from 'node:crypto';
import type { GithubBinding, GithubTaskLink } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, ServiceUnavailableError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { id } from '../work/validation.js';
import type { GithubBindingRecord, GithubDelivery, GithubLinkRecord, GithubPorts, GithubUnitOfWork } from './ports.js';
export function githubId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value)) return value;
  throw new InvalidInputError('Provider ID must be a positive lossless integer', 'GITHUB_INVALID_ID');
}
function human(principal: Principal) {
  if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('A signed-in person is required', 'GITHUB_NEEDS_PERSON');
}
function bindingView(record: GithubBindingRecord): GithubBinding {
  const { id, workspaceId, projectId, state, createdAt, host, installationId, repositoryId, owner, name, private: privateRepo, url } = record;
  return { id, workspaceId, projectId, state, createdAt: createdAt.toISOString(), host, installationId, repositoryId, owner, name, private: privateRepo, url };
}
function linkView(record: GithubLinkRecord): GithubTaskLink { return { ...record, verifiedAt: record.verifiedAt.toISOString() }; }
async function current(ports: GithubPorts, principal: Principal, record: GithubBindingRecord) {
  if (record.state !== 'active') throw new ServiceUnavailableError('Repository integration is unavailable', 'GITHUB_BINDING_UNAVAILABLE');
  // The production provider pins current credentials before taking any binding lock.
  const proof = await ports.provider.repository(principal, record.installationId, record.repositoryId);
  const locked = await ports.rows.binding(record.id, true);
  if (!locked || locked.state !== 'active') throw new ServiceUnavailableError('Repository integration is unavailable', 'GITHUB_BINDING_UNAVAILABLE');
  if (proof.repositoryId !== locked.repositoryId || proof.installationId !== locked.installationId || proof.appId !== locked.appId
    || locked.authorizationGeneration !== record.authorizationGeneration || locked.authorUserId !== record.authorUserId)
    throw new NotFoundError('Repository', 'GITHUB_REPOSITORY_NOT_FOUND');
  return proof;
}
export function githubUseCases(uow: GithubUnitOfWork) {
  return {
    async bind(principal: Principal, projectId: string, input: { installationId: unknown; repositoryId: unknown }): Promise<GithubBinding> {
      human(principal); const project = id(projectId, 'projectId');
      const installationId = githubId(input?.installationId); const repositoryId = githubId(input?.repositoryId);
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'manage', project);
        const proof = await ports.provider.repository(principal, installationId, repositoryId);
        const record = await ports.rows.bind({ ...proof, id: randomUUID(), workspaceId, projectId: project,
          authorUserId: principal.id, authorGithubUserId: proof.githubUserId, state: 'active', createdAt: new Date() });
        return bindingView(record);
      });
    },
    async bindings(principal: Principal, projectId: string): Promise<GithubBinding[]> {
      human(principal); const project = id(projectId, 'projectId');
      return uow.run(async (ports) => {
        await ports.access.requireProject(principal, 'read', project);
        const records = (await ports.rows.bindings(project)).filter((record) => record.state === 'active');
        // There is no partially redacted list containing private names/counts for an unverified reader.
        for (const record of records) await current(ports, principal, record);
        return records.map(bindingView);
      });
    },
    async disconnect(principal: Principal, bindingId: string): Promise<void> {
      human(principal); const target = id(bindingId, 'bindingId');
      return uow.run(async (ports) => {
        const record = await ports.rows.binding(target);
        if (!record) throw new NotFoundError('Binding');
        await ports.access.requireProject(principal, 'manage', record.projectId);
        await ports.rows.disconnect(target);
      });
    },
    async link(principal: Principal, taskId: string, input: { bindingId: string; number: number; role: 'required_output' | 'related' }): Promise<GithubTaskLink> {
      human(principal); const task = id(taskId, 'taskId'); const target = id(input?.bindingId, 'bindingId');
      if (!Number.isSafeInteger(input?.number) || input.number < 1 || !['required_output', 'related'].includes(input?.role))
        throw new InvalidInputError('A positive pull request number and supported relationship are required');
      return uow.run(async (ports) => {
        const work = await ports.rows.task(task);
        if (!work) throw new NotFoundError('Work item');
        await ports.access.requireProject(principal, 'write', work.projectId);
        const binding = await ports.rows.binding(target);
        if (!binding || binding.projectId !== work.projectId || binding.workspaceId !== work.workspaceId) throw new NotFoundError('Binding');
        const repository = await current(ports, principal, binding);
        const facts = await ports.provider.pull(principal, repository, input.number);
        if (facts.repositoryId !== binding.repositoryId || facts.number !== input.number) throw new NotFoundError('Pull request');
        const record = await ports.rows.link({ ...work, id: randomUUID(), taskId: work.id, bindingId: target,
          role: input.role, facts, state: 'current', verifiedAt: new Date() });
        return linkView(record);
      });
    },
    async links(principal: Principal, taskId: string): Promise<GithubTaskLink[]> {
      human(principal); const task = id(taskId, 'taskId');
      return uow.run(async (ports) => {
        const work = await ports.rows.task(task);
        if (!work) throw new NotFoundError('Work item');
        await ports.access.requireProject(principal, 'read', work.projectId);
        const links = await ports.rows.links(task);
        for (const link of links) {
          const binding = await ports.rows.binding(link.bindingId);
          if (!binding || binding.projectId !== work.projectId) throw new NotFoundError('Binding');
          await current(ports, principal, binding); // retained/cached private facts need current proof too
        }
        return links.map(linkView);
      });
    },
    async admit(delivery: GithubDelivery) {
      if (delivery.origin === 'reconcile') id(delivery.targetBindingId, 'targetBindingId');
      else if (delivery.targetBindingId) throw new InvalidInputError('A webhook cannot select a Flux binding');
      return uow.run(async (ports) => {
        const outcome = await ports.rows.admit(delivery);
        if (outcome === 'conflict') throw new ConflictError('Delivery identity was reused with different content', 'GITHUB_DELIVERY_CONFLICT');
        return outcome;
      });
    },
    async reconcile(principal: Principal, bindingId: string) {
      human(principal); const target = id(bindingId, 'bindingId');
      return uow.run(async (ports) => {
        const located = await ports.rows.binding(target);
        if (!located) throw new NotFoundError('Binding');
        await ports.access.requireProject(principal, 'manage', located.projectId);
        const proof = await current(ports, principal, located);
        const pending = await ports.rows.pendingReconciliation(target);
        if (pending) return pending;
        const deliveryId = `reconcile-${randomUUID()}`;
        await ports.rows.admit({ id: deliveryId, appId: proof.appId, targetBindingId: target,
          digest: createHash('sha256').update(deliveryId).digest('hex'), event: 'reconcile', payload: {},
          installationId: proof.installationId, repositoryId: proof.repositoryId, providerObjectId: null, origin: 'reconcile' });
        return deliveryId;
      });
    },
    async schedule(appId: string, window: string) {
      githubId(appId); githubId(window);
      const candidates = await uow.run((ports) => ports.rows.reconciliationCandidates(appId, window, 5));
      let created = 0;
      // One binding per transaction also prevents cross-project lock ordering and partial fanout.
      for (const candidate of candidates) {
        const outcome = await uow.run(async (ports) => {
          const binding = await ports.rows.binding(candidate.id, true);
          if (!binding || binding.state !== 'active' || binding.appId !== appId || await ports.rows.pendingReconciliation(binding.id)) return 'skipped';
          const deliveryId = `gap-${binding.id}-${window}`;
          return ports.rows.admit({ id: deliveryId, appId, targetBindingId: binding.id,
            digest: createHash('sha256').update(deliveryId).digest('hex'), event: 'reconcile', payload: {},
            installationId: binding.installationId, repositoryId: binding.repositoryId, providerObjectId: null, origin: 'reconcile' });
        });
        if (outcome === 'created') created++;
      }
      return created;
    },
    async process(deliveryId: string, bindingId: string) {
      return uow.run(async (ports) => {
        const located = await ports.rows.binding(bindingId);
        if (located && located.state !== 'active') {
          // A disconnected or revoked binding never regains this delivery's authority; stop retrying it so it can be pruned.
          if (await ports.rows.processing(deliveryId, bindingId) === 'pending') await ports.rows.complete(deliveryId, bindingId, 'GITHUB_BINDING_UNAVAILABLE');
          return 'binding_unavailable';
        }
        if (!located?.authorUserId) throw new ServiceUnavailableError('Binding authorization is unavailable', 'GITHUB_BINDING_UNAVAILABLE');
        const principal: Principal = { kind: 'human', id: located.authorUserId };
        await ports.access.requireProject(principal, 'read', located.projectId);
        const binding = await ports.rows.binding(bindingId);
        if (!binding) throw new NotFoundError('Binding');
        const proof = await current(ports, principal, binding);
        const pending = await ports.rows.processing(deliveryId, bindingId);
        if (pending !== 'pending') return 'already_completed';
        if (proof.authorizationGeneration !== binding.authorizationGeneration || proof.githubUserId !== binding.authorGithubUserId)
          throw new ServiceUnavailableError('Reauthorize this binding before background reconciliation', 'GITHUB_AUTHORIZATION_CHANGED');
        const delivery = await ports.rows.delivery(deliveryId);
        if (!delivery) throw new NotFoundError('Delivery');
        for (const link of await ports.rows.linkedPulls(bindingId)) {
          // An unrelated external comment cannot generate requests for all linked work.
          const pull = delivery.payload.pull_request as { id?: unknown } | undefined;
          const issue = delivery.payload.issue as { number?: unknown } | undefined;
          const check = delivery.payload[delivery.event] as { head_sha?: unknown; pull_requests?: { number?: unknown }[] } | undefined;
          if (delivery.event.startsWith('pull_request') && String(pull?.id ?? '') !== link.facts.pullId) continue;
          if (delivery.event === 'issue_comment' && issue?.number !== link.facts.number) continue;
          if (delivery.event === 'status' && delivery.payload.sha !== link.facts.headSha) continue;
          if (['check_run', 'check_suite'].includes(delivery.event) && check?.head_sha !== link.facts.headSha
            && !check?.pull_requests?.some((ref) => ref.number === link.facts.number)) continue;
          const facts = await ports.provider.pull(principal, proof, link.facts.number);
          if (facts.repositoryId !== binding.repositoryId || facts.pullId !== link.facts.pullId) throw new NotFoundError('Pull request');
          await ports.rows.saveFacts(link.id, facts);
          await ports.rows.bridge(delivery, binding, link, facts);
        }
        await ports.rows.complete(deliveryId, bindingId);
        return 'completed';
      });
    },
  };
}
