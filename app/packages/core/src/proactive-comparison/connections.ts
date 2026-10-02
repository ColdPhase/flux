import { createHash, randomUUID } from 'node:crypto';
import { AI_PROVIDERS, BACKGROUND_CONSENT_VERSION, isAiProviderKind, type AiPrice, type BackgroundComputeConnection,
  type ConnectBackgroundComputeCommand } from '@flux/contracts';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { refuseAllEndpoints, type AiEndpointPolicyPort } from '../ai/index.js';
import { isoDay, noPriceListing, resolveConnectionPrice, type AiPriceListing } from '../ai/price.js';
import { baseUrlSyntaxProblem, normalizeBaseUrl, validAiKey, validModelId, validPrice } from '../ai/validation.js';

export interface BackgroundKeySealer {
  seal(plainKey: string, ownerUserId: string, connectionId: string): string;
}
export interface BackgroundConnectionPort {
  replace(input: { id: string; ownerUserId: string; encryptedKey: string; keyLastFour: string; keyFingerprint: string;
    price: AiPrice | null; consentVersion: BackgroundComputeConnection['consentVersion'];
    command: Omit<ConnectBackgroundComputeCommand, 'apiKey' | 'price'> }): Promise<BackgroundComputeConnection>;
  current(ownerUserId: string): Promise<BackgroundComputeConnection | null>;
  revoke(ownerUserId: string, connectionId: string): Promise<boolean>;
}
/** What a connection save needs beyond storage (F-020): the endpoint policy and the provider's price listing. */
export interface BackgroundConnectionProviders {
  endpoints: AiEndpointPolicyPort;
  listing: AiPriceListing;
  now?: () => Date;
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

/**
 * Enforces explicit provider payer, data-disclosure and thirty-day local budget consent, a key in
 * the selected provider's format, a bounded model id and, for an OpenAI-compatible endpoint only,
 * a well-formed base URL. Whether that URL's host may be reached is checked separately.
 */
export function validateBackgroundConnection(input: ConnectBackgroundComputeCommand): void {
  if (!input || typeof input !== 'object' || !isAiProviderKind(input.provider))
    throw new InvalidInputError('Choose a supported provider', 'AI_PROVIDER_INVALID');
  if (!validAiKey(input.provider, input.apiKey))
    throw new InvalidInputError(`The key does not look like a key of this provider. ${AI_PROVIDERS[input.provider].keyHint}`, 'AI_KEY_FORMAT');
  if (!validModelId(input.provider, input.model))
    throw new InvalidInputError('The model id must be 1–200 letters, digits or . _ : / @ + - and no provider-hosted tool variant', 'AI_MODEL_INVALID');
  if (input.provider === 'openai_compatible') {
    const problem = baseUrlSyntaxProblem(input.baseUrl);
    if (problem) throw new InvalidInputError(problem, 'AI_BASE_URL_INVALID');
  } else if (input.baseUrl !== undefined) {
    throw new InvalidInputError('A named provider always uses its own public API address', 'AI_BASE_URL_INVALID');
  }
  if (input.price !== undefined && !validPrice(input.price))
    throw new InvalidInputError('Prices are whole micro-dollars per 1M tokens, from 0 to 1,000,000,000', 'AI_PRICE_INVALID');
  if (!label(input.payerOrganization) || !label(input.providerWorkspace)
    || input.workspaceScopedKeyConfirmed !== true || input.payerAuthorityConfirmed !== true
    || input.providerBillingAcknowledged !== true || input.projectDataDisclosureAcknowledged !== true
    || !bounded(input.maxRunsPerDay, 1, 3) || input.periodDays !== 30
    || !bounded(input.periodBudgetCents, 5, 1000) || !bounded(input.perRunCents, 5, 50)
    || input.perRunCents > input.periodBudgetCents)
    throw new InvalidInputError('A workspace-scoped provider key, payer/disclosure consent and bounded thirty-day budget are required');
}

export function backgroundConnectionUseCases(port: BackgroundConnectionPort, sealer: BackgroundKeySealer,
  providers: BackgroundConnectionProviders = { endpoints: refuseAllEndpoints, listing: noPriceListing }) {
  return {
    async connect(principal: Principal, input: ConnectBackgroundComputeCommand): Promise<BackgroundComputeConnection> {
      const ownerUserId = owner(principal);
      validateBackgroundConnection(input);
      const baseUrl = input.provider === 'openai_compatible' ? normalizeBaseUrl(input.baseUrl!) : null;
      // Checked when saved and again at every dispatch (PROV-4); nothing is sent to it here.
      if (baseUrl) {
        const refused = await providers.endpoints.check(baseUrl);
        if (refused) throw new InvalidInputError(`This endpoint cannot be used: ${refused}`, 'AI_ENDPOINT_REFUSED');
      }
      const price = await resolveConnectionPrice({ provider: input.provider, model: input.model, baseUrl,
        ownerPrice: input.price, listing: providers.listing, today: isoDay(providers.now?.() ?? new Date()) });
      const id = randomUUID();
      const encryptedKey = sealer.seal(input.apiKey, ownerUserId, id);
      const keyFingerprint = createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16);
      const command = {
        provider: input.provider, model: input.model, ...(baseUrl ? { baseUrl } : {}),
        payerOrganization: input.payerOrganization, providerWorkspace: input.providerWorkspace,
        workspaceScopedKeyConfirmed: input.workspaceScopedKeyConfirmed,
        payerAuthorityConfirmed: input.payerAuthorityConfirmed,
        providerBillingAcknowledged: input.providerBillingAcknowledged,
        projectDataDisclosureAcknowledged: input.projectDataDisclosureAcknowledged,
        maxRunsPerDay: input.maxRunsPerDay, periodDays: input.periodDays,
        periodBudgetCents: input.periodBudgetCents, perRunCents: input.perRunCents,
      };
      return port.replace({ id, ownerUserId, encryptedKey, keyLastFour: input.apiKey.slice(-4), keyFingerprint,
        price, consentVersion: BACKGROUND_CONSENT_VERSION, command });
    },
    current(principal: Principal): Promise<BackgroundComputeConnection | null> { return port.current(owner(principal)); },
    async revoke(principal: Principal, connectionId: string): Promise<void> {
      const ownerUserId = owner(principal);
      if (typeof connectionId !== 'string' || !UUID.test(connectionId) || !await port.revoke(ownerUserId, connectionId))
        throw new NotFoundError('Background connection', 'BACKGROUND_CONNECTION_NOT_FOUND');
    },
  };
}
