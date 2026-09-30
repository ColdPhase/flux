/** GitHub App facts are a separately authorized audience (#74/CO-3). */
export const GITHUB_WEBHOOK_PATH = '/api/v1/integrations/github/webhook';
export const GITHUB_CALLBACK_PATH = '/api/v1/integrations/github/callback';
export interface GithubRepository {
  host: 'github.com'; installationId: string; repositoryId: string;
  owner: string; name: string; private: boolean; url: string;
}
export interface GithubBinding extends GithubRepository {
  id: string; workspaceId: string; projectId: string;
  state: 'active' | 'disconnected' | 'revoked'; createdAt: string;
}
export interface GithubCheck {
  id: string; name: string; appId: string | null;
  state: 'pending' | 'success' | 'failure' | 'neutral'; sourceUpdatedAt: string;
}
export interface GithubReview {
  id: string; author: { id: string; login: string }; headSha: string;
  state: string; sourceSubmittedAt: string | null;
}
export interface GithubPullFacts {
  repositoryId: string; pullId: string; number: number; title: string; url: string;
  author: { id: string; login: string }; headSha: string;
  state: 'open' | 'closed'; draft: boolean; merged: boolean;
  sourceCreatedAt: string; sourceUpdatedAt: string; sourceMergedAt: string | null;
  checks: GithubCheck[]; reviews: GithubReview[]; truncated: boolean;
  /** This aggregate never certifies protected-branch merge eligibility. */
  execution: 'draft' | 'checks_pending' | 'checks_failed' | 'ready_for_review' | 'merged' | 'closed_unmerged';
}
export interface GithubTaskLink {
  id: string; workspaceId: string; projectId: string; taskId: string;
  bindingId: string; role: 'required_output' | 'related';
  facts: GithubPullFacts; verifiedAt: string; state: 'current' | 'stale' | 'unavailable';
}
export interface GithubCapabilities {
  status: 'configured' | 'unavailable'; authorization: 'connected' | 'required' | 'uncertain';
  /** Native-stage publication and #153 delivery are disabled until their audience gates exist. */
  taskAutomation: 'unavailable'; agentDelivery: 'unavailable';
}
