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
  status: 'enabled' | 'paused' | 'revoked';
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

/** A rule has no allowance of its own: its comparisons count against the background API key's one daily budget (#854). */
export interface CreateProactiveComparisonRule {
  agentId: string;
  purpose: 'camera_sensor_comparison';
  dataScope: 'current_project_published';
  permittedEffect: 'quiet_project_proposal';
  trigger: 'human_negative_result';
}
