import { createHash, randomUUID } from 'node:crypto';
import { GITHUB_RULE_MODES, type GithubRuleDefault, type GithubRuleMode, type GithubTaskRuleView, type NamedPrincipal, type SetGithubRuleDefaultCommand,
  type SetGithubTaskRuleCommand } from '@flux/contracts';
import { DomainError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError, ServiceUnavailableError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { sortedIds } from '../work/task-graph.js';
import { expectedVersion, id } from '../work/validation.js';
import type { GithubBindingRecord, GithubDelivery, GithubPorts, GithubRepositoryProof, GithubTaskState, GithubUnitOfWork } from './ports.js';
import { defaultGithubRuleMode, evaluateGithubRule, presentGithubRule, type GithubRuleRecord, type GithubRulePull } from './rules.js';

// "Let linked PRs move this task" (#74 G-1a): turning the rule on, its project default, and applying it inside the
// existing per-binding processing unit. A rule acts on its author's CURRENT authority: Flux write access to the
// task's project and their own GitHub access, at the authorization generation captured when they turned it on, to the
// repository of every required link. Lock order follows the GitHub unit: credential pins, binding, task graph, the
// sorted task rows, rule rows, then changes and the final event batch.

const CHANGE_LIMIT = 20;
const LOST_ACCESS = new Set(['GITHUB_AUTHORIZATION_REQUIRED', 'GITHUB_REFRESH_UNCERTAIN', 'GITHUB_ACCESS_UNAVAILABLE',
  'GITHUB_REPOSITORY_NOT_FOUND', 'GITHUB_PERMISSION_PROFILE_INVALID', 'GITHUB_AUTHORIZATION_CHANGED']);

function person(principal: Principal) {
  if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('A signed-in person is required', 'GITHUB_NEEDS_PERSON');
}

/** The rule revision the person saw (0: none); the compare-and-set of a rule command, beside the task version. */
function ruleRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidInputError('expectedRuleRevision must be a non-negative integer');
  return value;
}

function mode(value: unknown, nullable = false): GithubRuleMode | null | undefined {
  if (value === undefined || (nullable && value === null)) return value as undefined | null;
  if (typeof value !== 'string' || !(GITHUB_RULE_MODES as readonly string[]).includes(value)) throw new InvalidInputError(`mode must be one of ${GITHUB_RULE_MODES.join(', ')}`);
  return value as GithubRuleMode;
}

/** The task state the rule now expects; it owns a block only while the task stays blocked. */
function expecting(rule: GithubRuleRecord, task: GithubTaskState): GithubRuleRecord {
  return { ...rule, expectedVersion: task.version, expectedStatus: task.status, expectedBlocker: task.blocker,
    blockedBy: task.status === 'blocked' ? rule.blockedBy : null, updatedAt: new Date() };
}

async function presentView(ports: GithubPorts, task: GithubTaskState): Promise<GithubTaskRuleView> {
  const rule = (await ports.rows.taskRules([task.id])).get(task.id);
  const changes = await ports.rows.ruleChanges(task.id, CHANGE_LIMIT);
  const names = await ports.tasks.names([rule?.authorUserId, ...changes.map((change) => change.authorUserId)].filter((value): value is string => !!value));
  const named = (userId: string | null): NamedPrincipal | null => userId ? { kind: 'human', id: userId, name: names.get(userId) ?? 'Former member' } : null;
  return {
    taskId: task.id,
    rule: rule ? { ...presentGithubRule(rule, task), setUpBy: named(rule.authorUserId) } : null,
    changes: changes.map((change) => ({ id: change.id, code: change.code, from: change.fromStatus, to: change.toStatus, blocker: change.blocker,
      readyToClose: change.readyToClose, pullNumber: change.pullNumber, linkId: change.linkId, headSha: change.headSha, checkName: change.checkName,
      cause: { origin: change.origin, deliveryId: change.deliveryId }, setUpBy: named(change.authorUserId), at: change.createdAt.toISOString() })),
  };
}

/** A local reconciliation of this binding (the caller holds its row lock), unless one is already pending. */
export async function scheduleRuleReconciliation(ports: GithubPorts, binding: GithubBindingRecord) {
  if (await ports.rows.pendingReconciliation(binding.id)) return;
  const deliveryId = `reconcile-${randomUUID()}`;
  await ports.rows.admit({ id: deliveryId, appId: binding.appId, targetBindingId: binding.id, digest: createHash('sha256').update(deliveryId).digest('hex'),
    event: 'reconcile', payload: {}, installationId: binding.installationId, repositoryId: binding.repositoryId, providerObjectId: null, origin: 'reconcile' });
}

function activeRule(task: GithubTaskState, principal: Principal, proof: GithubRepositoryProof, chosen: GithubRuleMode, existing: GithubRuleRecord | null): GithubRuleRecord {
  return { taskId: task.id, workspaceId: task.workspaceId, projectId: task.projectId, mode: chosen, state: 'active', suspendedReason: null,
    authorUserId: principal.id, authorGithubUserId: proof.githubUserId, authorGeneration: proof.authorizationGeneration, appId: proof.appId,
    expectedVersion: task.version, expectedStatus: task.status, expectedBlocker: task.blocker,
    // Resuming keeps a block only while the task still shows exactly the blocker this rule wrote; a person's own or
    // reworded blocker is never adopted, so the rule never clears text a person wrote.
    blockedBy: task.status === 'blocked' && existing?.state !== 'off' && existing?.blockedBy && task.blocker === existing.expectedBlocker ? existing.blockedBy : null,
    readyToClose: existing?.state === 'off' ? false : existing?.readyToClose ?? false, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date() };
}

/**
 * Turns the rule on (or changes its mode, or resumes it) as `principal`, who becomes its author. They need current
 * write access and their own GitHub access to the repository of every required link; their GitHub identity and
 * authorization generation are captured. A reconciliation of each repository then applies it to current facts.
 */
async function enable(ports: GithubPorts, principal: Principal, work: { id: string; projectId: string }, version: number, chosen: GithubRuleMode | undefined, revision?: number) {
  const required = (await ports.rows.links(work.id)).filter((link) => link.role === 'required_output');
  if (!required.length) throw new RuleViolationError('Link a required pull request to this task first', 'GITHUB_RULE_NEEDS_REQUIRED_PR');
  const bindings: GithubBindingRecord[] = [];
  let proof: GithubRepositoryProof | null = null;
  // Credential pins (inside the provider) precede every binding and task lock.
  for (const bindingId of sortedIds(required.map((link) => link.bindingId), 'bindingIds')) {
    const binding = await ports.rows.binding(bindingId);
    if (!binding || binding.state !== 'active' || binding.projectId !== work.projectId)
      throw new ServiceUnavailableError('A linked repository is unavailable; reconnect it first', 'GITHUB_BINDING_UNAVAILABLE');
    const checked = await ports.provider.repository(principal, binding.installationId, binding.repositoryId);
    if (checked.repositoryId !== binding.repositoryId || checked.appId !== binding.appId) throw new NotFoundError('Repository', 'GITHUB_REPOSITORY_NOT_FOUND');
    proof = checked; bindings.push(binding);
  }
  for (const binding of bindings) {
    const locked = await ports.rows.binding(binding.id, true);
    if (!locked || locked.state !== 'active') throw new ServiceUnavailableError('A linked repository is unavailable; reconnect it first', 'GITHUB_BINDING_UNAVAILABLE');
    await scheduleRuleReconciliation(ports, locked);
  }
  const task = await ports.tasks.find(work.id, true);
  if (!task) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
  if (task.version !== version) throw new VersionConflictError(task.version, await presentView(ports, task));
  const existing = await ports.rows.rule(work.id, true);
  if (revision !== undefined && (existing?.revision ?? 0) !== revision) throw new VersionConflictError(task.version, await presentView(ports, task));
  await ports.rows.saveRule(activeRule(task, principal, proof!, chosen ?? existing?.mode ?? defaultGithubRuleMode(task.criteria), existing));
  await ports.tasks.updated(principal, task);
  return presentView(ports, task);
}

export function githubRuleUseCases(uow: GithubUnitOfWork) {
  async function located(ports: GithubPorts, principal: Principal, taskId: string, action: 'read' | 'write') {
    const work = await ports.rows.task(taskId);
    if (!work) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
    await ports.access.requireProject(principal, action, work.projectId);
    return work;
  }
  return {
    /** The rule and its last automatic changes, for everyone who can read the task. */
    async read(principal: Principal, taskId: string): Promise<GithubTaskRuleView> {
      const task = id(taskId, 'taskId');
      return uow.run(async (ports) => {
        await located(ports, principal, task, 'read');
        return presentView(ports, (await ports.tasks.find(task))!);
      });
    },
    /** Turns the rule on or off, or changes its mode, at the task version the person saw. Writers only. */
    async set(principal: Principal, taskId: string, command: SetGithubTaskRuleCommand): Promise<GithubTaskRuleView> {
      person(principal); const task = id(taskId, 'taskId');
      if (!command || typeof command.enabled !== 'boolean') throw new InvalidInputError('enabled must be true or false');
      const version = expectedVersion(command.expectedVersion); const chosen = mode(command.mode) ?? undefined; const revision = ruleRevision(command.expectedRuleRevision);
      return uow.run(async (ports) => {
        const work = await located(ports, principal, task, 'write');
        if (command.enabled) return enable(ports, principal, work, version, chosen, revision);
        const current = await ports.tasks.find(task, true);
        if (!current) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
        if (current.version !== version) throw new VersionConflictError(current.version, await presentView(ports, current));
        const rule = await ports.rows.rule(task, true);
        if (revision !== undefined && (rule?.revision ?? 0) !== revision) throw new VersionConflictError(current.version, await presentView(ports, current));
        if (rule && rule.state !== 'off') {
          await ports.rows.saveRule({ ...rule, state: 'off', suspendedReason: null, blockedBy: null, readyToClose: false, revision: rule.revision + 1, updatedAt: new Date() });
          await ports.tasks.updated(principal, current);
        }
        return presentView(ports, current);
      });
    },
    /** Resumes a suspended rule as the person resuming it, from the task's current state. */
    async resume(principal: Principal, taskId: string, command: { expectedVersion: number; expectedRuleRevision?: number }): Promise<GithubTaskRuleView> {
      person(principal); const task = id(taskId, 'taskId'); const version = expectedVersion(command?.expectedVersion); const revision = ruleRevision(command?.expectedRuleRevision);
      return uow.run(async (ports) => {
        const work = await located(ports, principal, task, 'write');
        const rule = await ports.rows.rule(task);
        if (!rule || rule.state === 'off') throw new RuleViolationError('Turn the rule on first', 'GITHUB_RULE_OFF');
        return enable(ports, principal, work, version, rule.mode, revision);
      });
    },
    async ruleDefault(principal: Principal, projectId: string): Promise<GithubRuleDefault | null> {
      const project = id(projectId, 'projectId');
      return uow.run(async (ports) => {
        await ports.access.requireProject(principal, 'read', project);
        const value = await ports.rows.ruleDefault(project);
        if (!value) return null;
        const names = await ports.tasks.names(value.setByUserId ? [value.setByUserId] : []);
        return { mode: value.mode, setBy: value.setByUserId ? { kind: 'human', id: value.setByUserId, name: names.get(value.setByUserId) ?? 'Former member' } : null };
      });
    },
    /** A project manager's default for new required links: the writer who links one turns the task's rule on. */
    async setRuleDefault(principal: Principal, projectId: string, command: SetGithubRuleDefaultCommand): Promise<GithubRuleDefault | null> {
      person(principal); const project = id(projectId, 'projectId');
      if (!command || typeof command.enabled !== 'boolean') throw new InvalidInputError('enabled must be true or false');
      const chosen = mode(command.mode, true) ?? null;
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'manage', project);
        await ports.rows.setRuleDefault({ workspaceId, projectId: project }, command.enabled ? { mode: chosen, setByUserId: principal.id } : null);
        if (!command.enabled) return null;
        const names = await ports.tasks.names([principal.id]);
        return { mode: chosen, setBy: { kind: 'human', id: principal.id, name: names.get(principal.id) ?? 'Former member' } };
      });
    },
  };
}

/**
 * After a writer verified and linked a required PR (holding the binding lock): with an active rule, or the project
 * default and no rule yet, a reconciliation applies the rule to current facts. The default makes the linker its author.
 */
export async function adoptGithubRuleOnLink(ports: GithubPorts, principal: Principal, taskId: string, binding: GithubBindingRecord, proof: GithubRepositoryProof) {
  const existing = await ports.rows.rule(taskId);
  const fallback = existing ? null : await ports.rows.ruleDefault(binding.projectId);
  if (existing?.state !== 'active' && !fallback) return;
  await scheduleRuleReconciliation(ports, binding);
  if (existing) return;
  const task = await ports.tasks.find(taskId, true);
  if (!task || await ports.rows.rule(taskId, true)) return;
  await ports.rows.saveRule(activeRule(task, principal, proof, fallback!.mode ?? defaultGithubRuleMode(task.criteria), null));
  await ports.tasks.updated(principal, task);
}

type Verdict = 'ok' | 'skip' | 'lost';
export type GithubRuleAuthority = Map<string, { authorUserId: string | null; verdict: Verdict }>;
const worse = (a: Verdict, b: Verdict): Verdict => a === 'lost' || b === 'lost' ? 'lost' : a === 'skip' || b === 'skip' ? 'skip' : 'ok';

/** A permanent loss of access suspends the rule; a GitHub outage only skips this delivery. */
function classify(error: unknown): Verdict {
  if (error instanceof NotFoundError || error instanceof ForbiddenError) return 'lost';
  if (error instanceof DomainError && LOST_ACCESS.has(error.code)) return 'lost';
  return 'skip';
}

/**
 * The current authority of every active rule that a delivery to this binding can reach, checked BEFORE the binding
 * lock (credential pins precede binding locks): the author's Flux write access and their own GitHub access, at the
 * captured identity and generation, to the repository of every required link of their tasks.
 */
export async function githubRuleAuthority(ports: GithubPorts, binding: GithubBindingRecord): Promise<GithubRuleAuthority> {
  const authority: GithubRuleAuthority = new Map();
  const byAuthor = new Map<string, GithubRuleRecord[]>();
  for (const rule of await ports.rows.activeRules(binding.id)) {
    if (!rule.authorUserId) authority.set(rule.taskId, { authorUserId: null, verdict: 'lost' });
    else byAuthor.set(rule.authorUserId, [...byAuthor.get(rule.authorUserId) ?? [], rule]);
  }
  for (const author of [...byAuthor.keys()].sort()) {
    const principal: Principal = { kind: 'human', id: author };
    const rules = byAuthor.get(author)!;
    let flux: Verdict = 'ok';
    try { await ports.access.requireProject(principal, 'write', binding.projectId); } catch (error) {
      if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
      flux = 'lost';
    }
    const repositories = new Map<string, string[]>();
    for (const rule of rules) repositories.set(rule.taskId, sortedIds((await ports.rows.links(rule.taskId))
      .filter((link) => link.role === 'required_output').map((link) => link.bindingId), 'bindingIds'));
    const proofs = new Map<string, GithubRepositoryProof | Verdict>();
    if (flux === 'ok') {
      for (const bindingId of [...new Set([...repositories.values()].flat())].sort()) {
        const other = bindingId === binding.id ? binding : await ports.rows.binding(bindingId);
        if (!other || other.state !== 'active') continue; // its links are unavailable, so the rule waits
        try {
          const proof = await ports.provider.repository(principal, other.installationId, other.repositoryId);
          proofs.set(bindingId, proof.repositoryId === other.repositoryId && proof.appId === other.appId ? proof : 'lost');
        } catch (error) { proofs.set(bindingId, classify(error)); }
      }
    }
    for (const rule of rules) {
      let verdict: Verdict = flux;
      for (const bindingId of flux === 'ok' ? repositories.get(rule.taskId)! : []) {
        const proof = proofs.get(bindingId);
        if (typeof proof === 'string') verdict = worse(verdict, proof);
        else if (proof && (proof.authorizationGeneration !== rule.authorGeneration || proof.githubUserId !== rule.authorGithubUserId || proof.appId !== rule.appId))
          verdict = 'lost'; // a reconnect, even as the same person, needs an explicit resume
      }
      authority.set(rule.taskId, { authorUserId: author, verdict });
    }
  }
  return authority;
}

async function requiredPulls(ports: GithubPorts, taskId: string): Promise<GithubRulePull[]> {
  const pulls: GithubRulePull[] = [];
  for (const link of (await ports.rows.links(taskId)).filter((item) => item.role === 'required_output')) {
    const binding = await ports.rows.binding(link.bindingId);
    pulls.push({ linkId: link.id, number: link.facts.number, available: link.state === 'current' && binding?.state === 'active',
      state: link.facts.state, merged: link.facts.merged, headSha: link.facts.headSha, checks: link.facts.checks, truncated: link.facts.truncated });
  }
  return pulls;
}

/**
 * Applies every reachable active rule of `taskIds` to the facts just saved by this delivery's processing, in the same
 * transaction. Duplicate and late deliveries re-read the same current facts, so they change nothing a second time.
 */
export async function applyGithubRules(ports: GithubPorts, context: { delivery: GithubDelivery; binding: GithubBindingRecord; taskIds: readonly string[]; authority: GithubRuleAuthority }) {
  const { delivery, binding, authority } = context;
  const targets = context.taskIds.filter((taskId) => authority.has(taskId)).sort();
  if (!targets.length) return;
  const tasks = await ports.tasks.lockForRules(binding.workspaceId, binding.projectId, targets);
  for (const taskId of targets) {
    const granted = authority.get(taskId)!; const task = tasks.get(taskId);
    const rule = await ports.rows.rule(taskId, true);
    // A rule changed or re-authored since the authority check waits for the next delivery.
    if (!task || !rule || rule.state !== 'active' || rule.authorUserId !== granted.authorUserId || granted.verdict === 'skip') continue;
    const actor: Principal = { kind: 'human', id: rule.authorUserId ?? binding.authorUserId! };
    const record = async (next: GithubRuleRecord, change: { code: Parameters<GithubPorts['rows']['recordRuleChange']>[0]['code']; to: GithubTaskState;
      blocker: string | null; pull: GithubRulePull | null; checkName: string | null }) => {
      await ports.rows.saveRule({ ...next, revision: rule.revision + 1 });
      await ports.rows.recordRuleChange({ id: randomUUID(), workspaceId: task.workspaceId, projectId: task.projectId, taskId, code: change.code,
        fromStatus: task.status, toStatus: change.to.status, blocker: change.blocker, readyToClose: next.readyToClose, authorUserId: rule.authorUserId,
        linkId: change.pull?.linkId ?? null, pullNumber: change.pull?.number ?? null, headSha: change.pull?.headSha ?? null, checkName: change.checkName,
        deliveryId: delivery.id, bindingId: binding.id, origin: delivery.origin, taskVersion: change.to.version, createdAt: new Date() });
      await ports.tasks.updated(actor, change.to, true);
    };
    if (granted.verdict === 'lost') {
      await record({ ...rule, state: 'suspended', suspendedReason: 'author_access', updatedAt: new Date() },
        { code: 'suspended_access', to: task, blocker: null, pull: null, checkName: null });
      continue;
    }
    const outcome = evaluateGithubRule(rule, task, await requiredPulls(ports, taskId));
    if (outcome.kind === 'suspend') {
      await record({ ...rule, state: 'suspended', suspendedReason: 'manual_change', blockedBy: task.status === 'blocked' ? rule.blockedBy : null, updatedAt: new Date() },
        { code: 'suspended_manual', to: task, blocker: null, pull: null, checkName: null });
    } else if (outcome.kind === 'none') {
      if (outcome.repin) await ports.rows.saveRule(expecting(rule, task));
    } else {
      const { effect } = outcome;
      const moved = outcome.task ? await ports.tasks.move(taskId, { status: effect.status, blocker: effect.blocker }) : task;
      await record({ ...expecting(rule, moved), blockedBy: effect.blockedBy, readyToClose: effect.readyToClose },
        { code: effect.code, to: moved, blocker: effect.status === 'blocked' ? effect.blocker : null, pull: effect.pull, checkName: effect.checkName });
    }
  }
}
