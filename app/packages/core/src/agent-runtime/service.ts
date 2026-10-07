import { randomUUID } from 'node:crypto';
import {
  AGENT_RUNTIME_ERRORS, type AgentRuntimeClient, type AgentRuntimeConnection, type AgentRuntimePayer, type AgentRuntimeSignInMethod, type AgentRuntimeStatus,
} from '@flux/contracts';
import { ConflictError, ServiceUnavailableError } from '../access/errors.js';
import { clientAvailability, type AgentRuntimeConfig } from './config.js';
import type { AgentRuntimeStore, RuntimeBindingRow, RuntimeClientStatus, RuntimeConnectionRow, RuntimeManagerPort } from './ports.js';

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
  /** Records the CLI's own status after the console ended; only that can make the connection signed in. */
  recordSignIn(ownerUserId: string, target: { bindingId: string; client: AgentRuntimeClient; method: AgentRuntimeSignInMethod | null }, status: RuntimeClientStatus): Promise<AgentRuntimeStatus>;
  /** Reads the CLI's own status again (a console closed before its result, or a change at the vendor). */
  check(ownerUserId: string, client: AgentRuntimeClient): Promise<AgentRuntimeStatus>;
  /** *Sign out*: the CLI's own logout, then its files are deleted (even when the logout failed). */
  signOut(ownerUserId: string, client: AgentRuntimeClient): Promise<AgentRuntimeStatus>;
  dismissAccountNotice(ownerUserId: string, client: AgentRuntimeClient): Promise<AgentRuntimeStatus>;
}

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
  const unavailable = () => new ServiceUnavailableError('Your agent runtime could not be reached. Nothing changed; try again shortly', AGENT_RUNTIME_ERRORS.unavailable);

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
    if (binding?.state === 'releasing') throw new ConflictError('Your agent runtime is being removed', AGENT_RUNTIME_ERRORS.releasing);
    if (!binding || binding.state !== 'active') throw new ConflictError('Set up your agent runtime first', AGENT_RUNTIME_ERRORS.unavailable);
    return binding;
  }

  async function record(ownerUserId: string, target: { bindingId: string; client: AgentRuntimeClient; method: AgentRuntimeSignInMethod | null }, reported: RuntimeClientStatus) {
    const facts = reported.signedIn && reported.facts ? reported.facts : null;
    await store.recordSignIn({
      ownerUserId, bindingId: target.bindingId, client: target.client, method: target.method, signedIn: reported.signedIn,
      facts: facts && { authMethod: facts.authMethod, plan: facts.plan, accountLabel: facts.accountLabel },
      fingerprint: facts?.accountDigest && options.accountFingerprint ? options.accountFingerprint(facts.accountDigest) : null,
    });
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
    async recordSignIn(ownerUserId, target, reported) {
      requireOn();
      await record(ownerUserId, target, reported);
      return status(ownerUserId);
    },
    async check(ownerUserId, client) {
      requireOn();
      requireClient(client);
      const binding = await activeBinding(ownerUserId);
      const reported = await manager!.status(binding.slot, binding.id, client);
      if (!reported.ok) throw unavailable();
      await record(ownerUserId, { bindingId: binding.id, client, method: null }, reported.value);
      return status(ownerUserId);
    },
    async signOut(ownerUserId, client) {
      requireOn();
      const binding = await activeBinding(ownerUserId);
      const outcome = await manager!.logout(binding.slot, binding.id, client);
      if (!outcome.ok) throw unavailable();
      await store.recordSignOut(ownerUserId, binding.id, client, outcome.value.logout !== 'ok');
      return status(ownerUserId);
    },
    async dismissAccountNotice(ownerUserId, client) {
      requireOn();
      await store.dismissAccountNotice(ownerUserId, client);
      return status(ownerUserId);
    },
  };
}
