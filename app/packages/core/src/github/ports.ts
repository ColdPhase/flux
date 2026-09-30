import type { GithubBinding, GithubPullFacts, GithubRepository, GithubTaskLink } from '@flux/contracts';
import type { Principal } from '../principal.js';
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
  complete(deliveryId: string, bindingId: string): Promise<void>;
  reconciliationCandidates(appId: string, window: string, limit: number): Promise<GithubBindingRecord[]>;
  pendingReconciliation(bindingId: string): Promise<string | null>;
  /** Internal metadata only; cannot deliver to a client until #153's audience adapter exists. */
  bridge(delivery: GithubDelivery, binding: GithubBindingRecord, link: GithubLinkRecord, facts: GithubPullFacts): Promise<void>;
}
export interface GithubPorts { access: GithubAccess; provider: GithubProvider; rows: GithubRepositoryPort }
export interface GithubUnitOfWork { run<T>(work: (ports: GithubPorts) => Promise<T>): Promise<T> }
