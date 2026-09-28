/** Metadata only. The API never returns the key or its ciphertext. */
export interface BackgroundComputeConnection {
  id: string;
  ownerUserId: string;
  provider: 'anthropic';
  model: 'claude-sonnet-5';
  payerOrganization: string;
  providerWorkspace: string;
  keyLastFour: string;
  keyFingerprint: string;
  maxRunsPerDay: number;
  periodDays: 30;
  periodBudgetCents: number;
  perRunCents: number;
  consentVersion: 'o-007-2026-09-28';
  consentedAt: string;
  createdAt: string;
}

/** An owner explicitly attests the provider payer/workspace and local budget. */
export interface ConnectBackgroundComputeCommand {
  apiKey: string;
  payerOrganization: string;
  providerWorkspace: string;
  workspaceScopedKeyConfirmed: true;
  payerAuthorityConfirmed: true;
  providerBillingAcknowledged: true;
  projectDataDisclosureAcknowledged: true;
  maxRunsPerDay: number;
  periodDays: 30;
  periodBudgetCents: number;
  perRunCents: number;
}
