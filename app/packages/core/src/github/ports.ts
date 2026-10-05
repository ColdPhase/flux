import type { GithubBinding, GithubPullFacts, GithubRepository, GithubRuleChangeCode, GithubRuleMode, GithubTaskLink, WorkStatus } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { GithubRuleRecord } from './rules.js';
export interface GithubBindingRecord extends Omit<GithubBinding, 'createdAt'> {
  createdAt: Date; authorUserId: string | null; authorGithubUserId: string;
  appId: string; authorizationGeneration: string;
}
export interface GithubLinkRecord extends Omit<GithubTaskLink, 'verifiedAt'> { verifiedAt: Date }
export interface GithubRepositoryProof extends GithubRepository {
  githubUserId: string; appId: string; authorizationGeneration: string;
}
export interface GithubDelivery {
  id: string; appId: string; digest: string; event: string; payload: Record<string, unknown>;
  installationId: string | null; repositoryId: string | null;
  origin: 'webhook' | 'reconcile'; providerObjectId: string | null;
  targetBindingId?: string | null;
}
export interface GithubProcessing { deliveryId: string; bindingId: string }
export interface GithubAccess {
  requireProject(principal: Principal, action: 'read' | 'write' | 'manage', projectId: string): Promise<{ workspaceId: string }>;
}
export interface GithubProvider {
  repository(principal: Principal, installationId: string, repositoryId: string): Promise<GithubRepositoryProof>;
  pull(principal: Principal, repository: GithubRepository, number: number): Promise<GithubPullFacts>;
}
export interface GithubRepositoryPort {
  binding(id: string, lock?: boolean): Promise<GithubBindingRecord | null>;
  bindings(projectId: string): Promise<GithubBindingRecord[]>;
  bind(record: GithubBindingRecord): Promise<GithubBindingRecord>;
  disconnect(id: string): Promise<void>;
  task(id: string): Promise<{ id: string; workspaceId: string; projectId: string } | null>;
  links(taskId: string): Promise<GithubLinkRecord[]>;
  linkedPulls(bindingId: string): Promise<GithubLinkRecord[]>;
  link(record: GithubLinkRecord): Promise<GithubLinkRecord>;
  saveFacts(id: string, facts: GithubPullFacts): Promise<void>;
  admit(delivery: GithubDelivery): Promise<'created' | 'duplicate' | 'conflict'>;
  delivery(id: string): Promise<GithubDelivery | null>;
  processing(deliveryId: string, bindingId: string): Promise<'pending' | 'completed' | null>;
  complete(deliveryId: string, bindingId: string, errorCode?: string): Promise<void>;
  reconciliationCandidates(appId: string, window: string, limit: number): Promise<GithubBindingRecord[]>;
  pendingReconciliation(bindingId: string): Promise<string | null>;
  /** Internal metadata only; cannot deliver to a client until #153's audience adapter exists. */
  bridge(delivery: GithubDelivery, binding: GithubBindingRecord, link: GithubLinkRecord, facts: GithubPullFacts): Promise<void>;
  rule(taskId: string, lock?: boolean): Promise<GithubRuleRecord | null>;
  saveRule(rule: GithubRuleRecord): Promise<void>;
  /** Active rules of tasks with a required link through this binding, ascending by task. No locks. */
  activeRules(bindingId: string): Promise<GithubRuleRecord[]>;
  recordRuleChange(change: GithubRuleChangeRecord): Promise<void>;
  ruleChanges(taskId: string, limit: number): Promise<GithubRuleChangeRecord[]>;
  ruleDefault(projectId: string): Promise<GithubRuleDefaultRecord | null>;
  setRuleDefault(scope: { workspaceId: string; projectId: string }, value: Omit<GithubRuleDefaultRecord, 'updatedAt'> | null): Promise<void>;
}
export interface GithubRuleChangeRecord {
  id: string; workspaceId: string; projectId: string; taskId: string; code: GithubRuleChangeCode;
  fromStatus: WorkStatus; toStatus: WorkStatus; blocker: string | null; readyToClose: boolean; authorUserId: string | null;
  linkId: string | null; pullNumber: number | null; headSha: string | null; checkName: string | null;
  deliveryId: string; bindingId: string; origin: 'webhook' | 'reconcile'; taskVersion: number; createdAt: Date;
}
export interface GithubRuleDefaultRecord { mode: GithubRuleMode | null; setByUserId: string | null; updatedAt: Date }
/** The native task as the rule reads and changes it. */
export interface GithubTaskState {
  id: string; workspaceId: string; projectId: string; status: WorkStatus; blocker: string | null; parked: boolean;
  criteria: string[]; version: number; prerequisitesMet: boolean;
}
/**
 * The native task side of a GitHub unit of work. Lock order inside it: the project task-graph lock, then one ascending
 * row-lock pass over the tasks and their direct prerequisites, then rule rows, then the changes and events.
 */
export interface GithubTasks {
  /** One task row, locked when asked; it takes no graph lock and is never a start/finish transition. */
  find(taskId: string, lock?: boolean): Promise<GithubTaskState | null>;
  /** The project graph lock, then the complete ascending pass over these tasks and their direct prerequisites. */
  lockForRules(workspaceId: string, projectId: string, taskIds: readonly string[]): Promise<Map<string, GithubTaskState>>;
  /** Changes status and blocker under the locks above and increments the version. */
  move(taskId: string, change: { status: WorkStatus; blocker: string | null }): Promise<GithubTaskState>;
  /** Queues `project.work_updated.v1` (identifiers only) in this unit's final event batch. */
  updated(principal: Principal, task: { id: string; workspaceId: string; projectId: string }): Promise<void>;
  /** Display names of people, keyed by user id. */
  names(userIds: readonly string[]): Promise<Map<string, string>>;
}
export interface GithubPorts { access: GithubAccess; provider: GithubProvider; rows: GithubRepositoryPort; tasks: GithubTasks }
export interface GithubUnitOfWork { run<T>(work: (ports: GithubPorts) => Promise<T>): Promise<T> }
