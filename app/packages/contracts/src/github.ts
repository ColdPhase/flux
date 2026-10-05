import type { NamedPrincipal, WorkStatus } from './work.js';

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
  /** Linked PRs can move their task once a writer turns the task's rule on (#74 G-1a). #153 delivery stays disabled. */
  taskAutomation: 'available' | 'unavailable'; agentDelivery: 'unavailable';
  /** The project default for new required PR links; null when new links start without a rule. */
  ruleDefault: GithubRuleDefault | null;
}

/**
 * How a task rule finishes once every required PR is merged (#74 G-1a): `complete` marks the task done when it has no
 * written criteria (Flux never checks criteria off); otherwise, and always in `ready`, the task shows Ready to close.
 */
export const GITHUB_RULE_MODES = ['complete', 'ready'] as const;
export type GithubRuleMode = (typeof GITHUB_RULE_MODES)[number];
export const githubTaskRulePath = (taskId: string) => `/api/v1/work/${taskId}/github-rule`;
export const githubTaskRuleResumePath = (taskId: string) => `/api/v1/work/${taskId}/github-rule/resume`;
export const githubRuleDefaultPath = (projectId: string) => `/api/v1/projects/${projectId}/github/rule-default`;

/**
 * "Let linked PRs move this task" (#74 G-1a). A person who can edit the task turns it on, and that publishes the status
 * changes its required PRs cause, with their PR numbers, head commits and check names, to everyone who can read the task.
 * Repository names, PR titles and other provider facts stay behind each reader's own GitHub access. The rule never
 * reassigns the task, changes its audience or touches parked, done or not-pursued work.
 */
export interface GithubTaskRule {
  mode: GithubRuleMode;
  /** `suspended` after a person changed the status or blocker by hand, or when the person who set it up lost access. */
  state: 'active' | 'suspended' | 'off';
  suspendedReason: 'manual_change' | 'author_access' | null;
  /** The person on whose authority the rule acts; the last one to turn it on, change its mode or resume it. */
  setUpBy: NamedPrincipal | null;
  /** The task version the rule last saw. A later manual change of status or blocker suspends it. */
  expectedVersion: number;
  /** Every required PR is merged but the rule did not finish the task: a person finishes it with one tap. */
  readyToClose: boolean;
  updatedAt: string;
}
export type GithubRuleChangeCode = 'pull_open' | 'pull_reopened' | 'check_failed' | 'checks_passed' | 'pull_closed'
  | 'merged_done' | 'merged_ready' | 'suspended_manual' | 'suspended_access';
/** One automatic change, shown in the task's history as "by GitHub rule · set up by <name>". */
export interface GithubRuleChange {
  id: string;
  code: GithubRuleChangeCode;
  from: WorkStatus;
  to: WorkStatus;
  /** The blocker the rule wrote, e.g. "PR #42 closed without merge". */
  blocker: string | null;
  readyToClose: boolean;
  pullNumber: number | null;
  /** The required link that caused it; readers with GitHub access can open it from their own link list. */
  linkId: string | null;
  headSha: string | null;
  checkName: string | null;
  /** The signed delivery or local reconciliation whose current provider facts caused the change. */
  cause: { origin: 'webhook' | 'reconcile'; deliveryId: string };
  setUpBy: NamedPrincipal | null;
  at: string;
}
export interface GithubTaskRuleView {
  taskId: string;
  rule: GithubTaskRule | null;
  /** Newest first, at most 20. */
  changes: GithubRuleChange[];
}
/** `expectedVersion` pins the task version the person saw; turning the rule on without `mode` picks the task's default. */
export interface SetGithubTaskRuleCommand {
  enabled: boolean;
  mode?: GithubRuleMode;
  expectedVersion: number;
}
export interface GithubRuleDefault {
  /** Null: Ready to close for tasks with written criteria, Complete for the others. */
  mode: GithubRuleMode | null;
  setBy: NamedPrincipal | null;
}
export interface SetGithubRuleDefaultCommand {
  enabled: boolean;
  mode?: GithubRuleMode | null;
}
