import { randomUUID } from 'node:crypto';
import {
  AGENT_RUNTIME_ERRORS, type AgentRuntimeClient, type AgentRuntimeConnection, type AgentRuntimePayer, type AgentRuntimeSignInMethod, type AgentRuntimeStatus,
} from '@flux/contracts';
import { ConflictError, ServiceUnavailableError } from '../access/errors.js';
import { clientAvailability, type AgentRuntimeConfig } from './config.js';
import type { AgentRuntimeStore, RuntimeBindingRow, RuntimeClientStatus, RuntimeConnectionRow, RuntimeManagerPort } from './ports.js';
import {
  RUNTIME_AUTH_COMMAND_LIFETIME_MS, RUNTIME_AUTH_CONSOLE_LIFETIME_MS, RUNTIME_AUTH_LEASE_MS,
  type RuntimeAuthActor, type RuntimeAuthKind, type RuntimeAuthOperation,
} from './auth.js';

// The owner's runtime (F-022 "One slot per owner"). The caller is always the session's own user: no
// input selects an owner, a slot or a binding, so one owner can never reach, start, inspect or sign in
// to another's slot through these use cases. A workspace role gives no access to any slot.
//
// Sign-in (T4 #279): the console runs in the owner's slot; these use cases name the slot and binding
// for the console, and record only what the CLI's own status reported afterwards: display facts, the
// payer they imply, and an account-change notice. A sign-in is never inferred from the console itself.

const DAY = 86_400_000;

function bindingView(binding: RuntimeBindingRow, idleDays: number | null) {
  const since = binding.lastUsedAt ?? binding.createdAt;
  return {
    state: binding.state,
    ...(binding.releaseReason === 'auth_recovery' ? { recovery: true as const } : {}),
    boundAt: binding.createdAt.toISOString(),
    lastUsedAt: binding.lastUsedAt?.toISOString() ?? null,
    idleReleaseAt: idleDays && binding.state === 'active' ? new Date(since.getTime() + idleDays * DAY).toISOString() : null,
  };
}

/** F-022 "Payer and data": from the reported method only; anything else is not known to Flux. */
export function runtimePayer(authMethod: string | null): AgentRuntimePayer {
  if (authMethod === 'claude.ai') return 'claude_plan';
  if (authMethod === 'api_key') return 'anthropic_console';
  return 'unknown';
}

function connectionView(row: RuntimeConnectionRow): AgentRuntimeConnection {
  const signedIn = row.state === 'signed_in';
  return {
    state: row.state,
    signInMethod: row.signInMethod,
    authMethod: signedIn ? row.authMethod : null,
    plan: signedIn ? row.plan : null,
    accountLabel: row.accountLabel,
    signedInAt: row.signedInAt?.toISOString() ?? null,
    payer: signedIn ? runtimePayer(row.authMethod) : null,
    accountChange: row.accountChangedAt ? { previousLabel: row.previousAccountLabel, at: row.accountChangedAt.toISOString() } : null,
    signOut: row.signedOutAt ? { at: row.signedOutAt.toISOString(), failed: row.signOutFailed === true } : null,
  };
}

export interface AgentRuntimeUseCases {
  status(ownerUserId: string): Promise<AgentRuntimeStatus>;
  /** Binds a free slot to the owner (idempotent), or binds their slot again after *Sign in again*. */
  bind(ownerUserId: string): Promise<AgentRuntimeStatus>;
  /** *Remove runtime*: the worker signs out, deletes the directory and frees the slot. */
  remove(ownerUserId: string): Promise<AgentRuntimeStatus>;
  /** Where the owner's sign-in console runs: their own slot, bound first if needed. */
  consoleTarget(ownerUserId: string, client: AgentRuntimeClient): Promise<{ slot: string; bindingId: string }>;
  beginConsole(actor: RuntimeAuthActor, client: AgentRuntimeClient, nonce: { digest: string; expiresAt: Date }): Promise<{ slot: string; operation: RuntimeAuthOperation }>;
  renewAuth(operation: RuntimeAuthOperation): Promise<boolean>;
  cancelAuth(operation: RuntimeAuthOperation): Promise<void>;
  /** Records the CLI's own status after the console ended; only that can make the connection signed in. */
  recordSignIn(ownerUserId: string, target: { operation: RuntimeAuthOperation; method: AgentRuntimeSignInMethod | null }, status: RuntimeClientStatus & { bootId: string }): Promise<RuntimeAuthCompletion>;
  /** Reads the CLI's own status again (a console closed before its result, or a change at the vendor). */
  check(ownerUserId: string, client: AgentRuntimeClient, sessionId: string): Promise<AgentRuntimeStatus>;
  /** *Sign out*: the CLI's own logout, then its files are deleted (even when the logout failed). */
  signOut(ownerUserId: string, client: AgentRuntimeClient, sessionId: string): Promise<AgentRuntimeStatus>;
  dismissAccountNotice(ownerUserId: string, client: AgentRuntimeClient): Promise<AgentRuntimeStatus>;
}
export interface RuntimeAuthCompletion { disposition: 'accepted' | 'superseded'; status: AgentRuntimeStatus; signedIn: boolean }

export interface AgentRuntimeOptions {
  /**
   * The keyed fingerprint of an account digest the slot reported (HMAC with a key only the API holds),
   * compared to tell a sign-in to a different account. Without it, accounts are compared by label.
   */
  accountFingerprint?: (digest: string) => string;
}

export function agentRuntimeUseCases(config: AgentRuntimeConfig, store: AgentRuntimeStore, manager: RuntimeManagerPort | null, options: AgentRuntimeOptions = {}): AgentRuntimeUseCases {
  const enabled = config.clients.length > 0 && manager !== null;
  const noConnections = (): AgentRuntimeStatus['connections'] => ({ claude_code: null, codex: null });
  const off = (): AgentRuntimeStatus => ({
    enabled: false, clients: clientAvailability(config), commercialTerms: null, idleReleaseDays: config.idleDays, pool: 'off', binding: null, lastRelease: null,
    connections: noConnections(),
  });
  const requireOn = () => {
    if (!enabled) throw new ConflictError('The agent runtime is off on this instance', AGENT_RUNTIME_ERRORS.off);
  };
  const requireClient = (client: AgentRuntimeClient) => {
    if (clientAvailability(config)[client] !== 'available') {
      throw new ConflictError('This program is not available in the agent runtime on this instance', AGENT_RUNTIME_ERRORS.clientUnavailable);
    }
  };
  const unavailable = () => new ServiceUnavailableError('The auth operation could not be confirmed. Runtime use is disabled while its storage is safely recovered; both clients may need to sign in again', AGENT_RUNTIME_ERRORS.unavailable);

  async function status(ownerUserId: string): Promise<AgentRuntimeStatus> {
    if (!enabled) return off();
    const view = await store.ownerView(ownerUserId);
    const pool = view.slots.ready > 0 ? 'available' : view.slots.total > 0 && view.slots.held >= view.slots.total ? 'full' : 'starting';
    const connections = noConnections();
    if (view.binding) for (const row of await store.connections(ownerUserId)) if (row.bindingId === view.binding.id) connections[row.client] = connectionView(row);
    return {
      enabled: true,
      clients: clientAvailability(config),
      commercialTerms: view.commercialTerms && { agreedOn: view.commercialTerms.agreedOn, recordedAt: view.commercialTerms.recordedAt.toISOString() },
      idleReleaseDays: config.idleDays,
      pool,
      binding: view.binding ? bindingView(view.binding, config.idleDays) : null,
      lastRelease: view.lastRelease && { reason: view.lastRelease.reason, at: view.lastRelease.at.toISOString(), signOutFailed: view.lastRelease.signOutFailed },
      connections,
      auth: Object.fromEntries((view.auth ?? []).map(a => [a.client, a.kind === 'console' ? 'signing_in' : a.kind === 'logout' ? 'signing_out' : 'checking'])),
    };
  }

  async function bindDirectory(binding: RuntimeBindingRow) {
    const outcome = await manager!.bind(binding.slot, binding.id);
    if (outcome.ok) { await store.activate(binding.id); return; }
    if (binding.state === 'binding') {
      await store.abandon(binding.id, outcome.code === 'data_not_empty' ? { state: 'out_of_pool', reason: 'data_not_empty' } : { state: 'unknown' });
    }
    throw new ServiceUnavailableError('The agent runtime could not prepare your slot; try again shortly', AGENT_RUNTIME_ERRORS.unavailable);
  }

  async function bind(ownerUserId: string) {
    requireOn();
    const reserved = await store.reserve(ownerUserId, randomUUID());
    if (reserved.kind === 'full') throw new ConflictError('Every agent runtime slot on this instance is in use', AGENT_RUNTIME_ERRORS.poolFull);
    if (reserved.kind === 'starting') throw new ServiceUnavailableError('The agent runtime is starting; try again shortly', AGENT_RUNTIME_ERRORS.unavailable);
    const { binding } = reserved;
    if (binding.state === 'releasing') throw new ConflictError('Your agent runtime is being removed', AGENT_RUNTIME_ERRORS.releasing);
    if (reserved.kind === 'reserved' || binding.state === 'sign_in_again') await bindDirectory(binding);
    return status(ownerUserId);
  }

  /** The owner's live, active binding, or a conflict that says why there is none. */
  async function activeBinding(ownerUserId: string): Promise<RuntimeBindingRow> {
    const binding = (await store.ownerView(ownerUserId)).binding;
    if (binding?.state === 'releasing') throw new ConflictError(binding.releaseReason === 'auth_recovery'
      ? 'Your runtime is waiting for confirmed cleanup; both clients may need to sign in again' : 'Your agent runtime is being removed', AGENT_RUNTIME_ERRORS.releasing);
    if (!binding || binding.state !== 'active') throw new ConflictError('Set up your agent runtime first', AGENT_RUNTIME_ERRORS.unavailable);
    return binding;
  }

  async function claim(actor: RuntimeAuthActor, client: AgentRuntimeClient, kind: RuntimeAuthKind, nonce?: { digest: string; expiresAt: Date }) {
    const binding = await activeBinding(actor.ownerUserId);
    const admitted = await store.claimAuth({ ...actor, bindingId: binding.id, client, kind, nonce,
      leaseMs: RUNTIME_AUTH_LEASE_MS, lifetimeMs: kind === 'console' ? RUNTIME_AUTH_CONSOLE_LIFETIME_MS : RUNTIME_AUTH_COMMAND_LIFETIME_MS });
    if (admitted.kind === 'busy') throw new ConflictError('Another auth operation is still using your runtime', 'AGENT_RUNTIME_AUTH_BUSY');
    if (admitted.kind === 'recovery') throw new ConflictError('Your runtime is waiting for confirmed cleanup; both clients may need to sign in again', 'AGENT_RUNTIME_AUTH_RECOVERY');
    if (admitted.kind !== 'claimed') throw new ConflictError('This auth operation is no longer current', 'AGENT_RUNTIME_AUTH_SUPERSEDED');
    return { binding, operation: admitted.operation };
  }
  async function record(ownerUserId: string, target: { operation: RuntimeAuthOperation; method: AgentRuntimeSignInMethod | null }, reported: RuntimeClientStatus & { bootId: string }) {
    const operation = target.operation;
    if (operation.ownerUserId !== ownerUserId || operation.bootId !== reported.bootId) {
      await store.recoverAuth(operation);
      return false;
    }
    const facts = reported.signedIn && reported.facts ? reported.facts : null;
    const accepted = await store.recordSignIn({
      operation, ownerUserId, bindingId: operation.bindingId, client: operation.client, method: target.method, signedIn: reported.signedIn,
      facts: facts && { authMethod: facts.authMethod, plan: facts.plan, accountLabel: facts.accountLabel },
      fingerprint: facts?.accountDigest && options.accountFingerprint ? options.accountFingerprint(facts.accountDigest) : null,
    });
    if (!accepted) await store.recoverAuth(operation);
    return accepted;
  }

  return {
    status,
    bind,
    async remove(ownerUserId) {
      requireOn();
      await store.requestRelease({ ownerUserId }, 'owner');
      return status(ownerUserId);
    },
    async consoleTarget(ownerUserId, client) {
      requireOn();
      requireClient(client);
      await bind(ownerUserId);
      const binding = await activeBinding(ownerUserId);
      return { slot: binding.slot, bindingId: binding.id };
    },
    async beginConsole(actor, client, nonce) {
      requireOn(); requireClient(client);
      await bind(actor.ownerUserId);
      const admitted = await claim(actor, client, 'console', nonce);
      return { slot: admitted.binding.slot, operation: admitted.operation };
    },
    renewAuth: (operation) => store.renewAuth(operation, RUNTIME_AUTH_LEASE_MS),
    async cancelAuth(operation) { await store.recoverAuth(operation); },
    async recordSignIn(ownerUserId, target, reported) {
      requireOn();
      const accepted = await record(ownerUserId, target, reported);
      return { disposition: accepted ? 'accepted' : 'superseded', status: await status(ownerUserId), signedIn: accepted && reported.signedIn && reported.facts !== null };
    },
    async check(ownerUserId, client, sessionId) {
      requireOn();
      requireClient(client);
      const { binding, operation } = await claim({ ownerUserId, sessionId }, client, 'check');
      try {
        const reported = await manager!.status(binding.slot, binding.id, client, operation.bootId);
        if (!reported.ok) { await store.recoverAuth(operation); throw unavailable(); }
        const accepted = await record(ownerUserId, { operation, method: null }, reported.value);
        return { ...await status(ownerUserId), authCompletion: { kind: 'check' as const, disposition: accepted ? 'accepted' as const : 'superseded' as const } };
      } catch (error) { await store.recoverAuth(operation); throw error; }
    },
    async signOut(ownerUserId, client, sessionId) {
      requireOn();
      const { binding, operation } = await claim({ ownerUserId, sessionId }, client, 'logout');
      try {
        const outcome = await manager!.logout(binding.slot, binding.id, client, operation.bootId);
        if (!outcome.ok || outcome.value.bootId !== operation.bootId) { await store.recoverAuth(operation); throw unavailable(); }
        const accepted = await store.recordSignOut(operation, outcome.value.logout !== 'ok');
        if (!accepted) await store.recoverAuth(operation);
        return { ...await status(ownerUserId), authCompletion: { kind: 'logout' as const, disposition: accepted ? 'accepted' as const : 'superseded' as const } };
      } catch (error) { await store.recoverAuth(operation); throw error; }
    },
    async dismissAccountNotice(ownerUserId, client) {
      requireOn();
      await store.dismissAccountNotice(ownerUserId, client);
      return status(ownerUserId);
    },
  };
}
