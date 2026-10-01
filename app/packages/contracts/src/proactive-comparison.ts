/** A standing personal authorization; result events and model credentials are separate. */
export interface ProactiveComparisonRule {
  id: string;
  projectId: string;
  ownerUserId: string;
  agentId: string;
  trigger: 'human_negative_result';
  purpose: 'camera_sensor_comparison';
  dataScope: 'current_project_published';
  permittedEffect: 'quiet_project_proposal';
  maxRunsPerDay: number;
  periodBudgetCents: number;
  perRunCents: number;
  status: 'enabled' | 'paused' | 'revoked';
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface CreateProactiveComparisonRule {
  agentId: string;
  maxRunsPerDay: number;
  periodBudgetCents: number;
  perRunCents: number;
  purpose: 'camera_sensor_comparison';
  dataScope: 'current_project_published';
  permittedEffect: 'quiet_project_proposal';
  trigger: 'human_negative_result';
}
