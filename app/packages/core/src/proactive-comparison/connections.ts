import { createHash, randomUUID } from 'node:crypto';
import type { BackgroundComputeConnection, ConnectBackgroundComputeCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';

export interface BackgroundKeySealer {
  seal(plainKey: string, ownerUserId: string, connectionId: string): string;
}
export interface BackgroundConnectionPort {
  replace(input: { id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
    command: Omit<ConnectBackgroundComputeCommand, 'apiKey'> }): Promise<BackgroundComputeConnection>;
  current(ownerUserId: string): Promise<BackgroundComputeConnection | null>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
}

function owner(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}
function bounded(value: number, low: number, high: number): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}
function label(value: string): boolean { return typeof value === 'string' && value.trim() === value && value.length >= 2 && value.length <= 120; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enforces explicit provider payer, data-disclosure and thirty-day local budget consent. */
export function validateBackgroundConnection(input: ConnectBackgroundComputeCommand): void {
  if (!input || typeof input !== 'object' || typeof input.apiKey !== 'string'
    || !/^sk-ant-[A-Za-z0-9_-]{16,256}$/.test(input.apiKey)
    || !label(input.payerOrganization) || !label(input.providerWorkspace)
    || input.workspaceScopedKeyConfirmed !== true || input.payerAuthorityConfirmed !== true
    || input.providerBillingAcknowledged !== true || input.projectDataDisclosureAcknowledged !== true
    || !bounded(input.maxRunsPerDay, 1, 3) || input.periodDays !== 30
    || !bounded(input.periodBudgetCents, 5, 1000) || !bounded(input.perRunCents, 5, 50)
    || input.perRunCents > input.periodBudgetCents)
    throw new InvalidInputError('A workspace-scoped provider key, payer/disclosure consent and bounded thirty-day budget are required');
}

export function backgroundConnectionUseCases(port: BackgroundConnectionPort, sealer: BackgroundKeySealer) {
  return {
    async connect(principal: Principal, input: ConnectBackgroundComputeCommand): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      validateBackgroundConnection(input);
      const id = randomUUID();
      const encryptedKey = sealer.seal(input.apiKey, ownerUserId, id);
      const keyFingerprint = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
      const command = {
        payerOrganization: input.payerOrganization, providerWorkspace: input.providerWorkspace,
        workspaceScopedKeyConfirmed: input.workspaceScopedKeyConfirmed,
        payerAuthorityConfirmed: input.payerAuthorityConfirmed,
        providerBillingAcknowledged: input.providerBillingAcknowledged,
        projectDataDisclosureAcknowledged: input.projectDataDisclosureAcknowledged,
        maxRunsPerDay: input.maxRunsPerDay, periodDays: input.periodDays,
        periodBudgetCents: input.periodBudgetCents, perRunCents: input.perRunCents,
      };
      return port.replace({ id, ownerUserId, encryptedKey, keyLastFour: input.apiKey.slice(-4), keyFingerprint, command });
    },
    current(principal: Principal): Promise<BackgroundComputeConnection | null> { return port.current(owner(principal)); },
    async revoke(principal: Principal, connectionId: string): Promise<void> {
      const ownerUserId = owner(principal);
      if (typeof connectionId !== 'string' || !UUID.test(connectionId) || !await port.revoke(ownerUserId, connectionId))
        throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    },
  };
}
