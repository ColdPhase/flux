import { randomUUID } from 'node:crypto';
import { AGENT_RUNTIME_ERRORS, type AgentRuntimeStatus } from '@flux/contracts';
import { ConflictError, ServiceUnavailableError } from '../access/errors.js';
import { clientAvailability, type AgentRuntimeConfig } from './config.js';
import type { AgentRuntimeStore, RuntimeBindingRow, RuntimeManagerPort } from './ports.js';

// The owner's runtime (F-022 "One slot per owner"). The caller is always the session's own user: no
// input selects an owner, a slot or a binding, so one owner can never reach, start, inspect or sign in
// to another's slot through these use cases. A workspace role gives no access to any slot.

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

export interface AgentRuntimeUseCases {
  status(ownerUserId: string): Promise<AgentRuntimeStatus>;
  /** Binds a free slot to the owner (idempotent), or binds their slot again after *Sign in again*. */
  bind(ownerUserId: string): Promise<AgentRuntimeStatus>;
  /** *Remove runtime*: the worker signs out, deletes the directory and frees the slot. */
  remove(ownerUserId: string): Promise<AgentRuntimeStatus>;
}

export function agentRuntimeUseCases(config: AgentRuntimeConfig, store: AgentRuntimeStore, manager: RuntimeManagerPort | null): AgentRuntimeUseCases {
  const enabled = config.clients.length > 0 && manager !== null;
  const off = (): AgentRuntimeStatus => ({
    enabled: false, clients: clientAvailability(config), commercialTerms: null, idleReleaseDays: config.idleDays, pool: 'off', binding: null, lastRelease: null,
  });
  const requireOn = () => {
    if (!enabled) throw new ConflictError('The agent runtime is off on this instance', AGENT_RUNTIME_ERRORS.off);
  };

  async function status(ownerUserId: string): Promise<AgentRuntimeStatus> {
    if (!enabled) return off();
    const view = await store.ownerView(ownerUserId);
    const pool = view.slots.ready > 0 ? 'available' : view.slots.total > 0 && view.slots.held >= view.slots.total ? 'full' : 'starting';
    return {
      enabled: true,
      clients: clientAvailability(config),
      commercialTerms: view.commercialTerms && { agreedOn: view.commercialTerms.agreedOn, recordedAt: view.commercialTerms.recordedAt.toISOString() },
      idleReleaseDays: config.idleDays,
      pool,
      binding: view.binding ? bindingView(view.binding, config.idleDays) : null,
      lastRelease: view.lastRelease && { reason: view.lastRelease.reason, at: view.lastRelease.at.toISOString(), signOutFailed: view.lastRelease.signOutFailed },
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

  return {
    status,
    async bind(ownerUserId) {
      requireOn();
      const reserved = await store.reserve(ownerUserId, randomUUID());
      if (reserved.kind === 'full') throw new ConflictError('Every agent runtime slot on this instance is in use', AGENT_RUNTIME_ERRORS.poolFull);
      if (reserved.kind === 'starting') throw new ServiceUnavailableError('The agent runtime is starting; try again shortly', AGENT_RUNTIME_ERRORS.unavailable);
      const { binding } = reserved;
      if (binding.state === 'releasing') throw new ConflictError('Your agent runtime is being removed', AGENT_RUNTIME_ERRORS.releasing);
      if (reserved.kind === 'reserved' || binding.state === 'sign_in_again') await bindDirectory(binding);
      return status(ownerUserId);
    },
    async remove(ownerUserId) {
      requireOn();
      await store.requestRelease({ ownerUserId }, 'owner');
      return status(ownerUserId);
    },
  };
}
