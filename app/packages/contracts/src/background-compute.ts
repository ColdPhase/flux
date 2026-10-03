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

/** Project-readable, quiet suggestion from one owner-funded background candidate. */
export interface ProactiveComparisonProposal {
  id: string;
  projectId: string;
  resultId: string;
  ownerUserId: string;
  agentId: string;
  audience: { kind: 'project'; projectId: string };
  computeSource: 'owner_background_claude_platform';
  model: 'claude-sonnet-5';
  /** Cited project source revisions, including the triggering result. Reads and changes omit those the current reader cannot open. */
  sources: Array<{ type: 'result' | 'message' | 'material' | 'work' | 'thought'; id: string; version: number; conversationId?: string; sketchId?: string; title?: string }>;
  fact: string;
  interpretation: string;
  suggestedAction: string;
  status: 'proposed' | 'dismissed' | 'used';
  version: number;
  editedByUserId: string | null;
  usedWorkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const proactiveComparisonProposalsPath = (projectId: string) =>
  `/api/v1/projects/${projectId}/proactive-comparison-proposals`;
