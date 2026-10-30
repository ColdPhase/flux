import { AI_MODEL_LISTS_PATH, backgroundComparisonRuntimePath, backgroundComputeConnectionPath, backgroundComputeConnectionsPath,
  proactiveComparisonRulePath, proactiveComparisonRulesPath, backgroundComputeUsagePath, type AiModelList, type AiModelListQuery,
  type BackgroundComparisonRuntime, type BackgroundComputeConnection, type BackgroundComputeUsage, type ConnectBackgroundComputeCommand, type CreateProactiveComparisonRule, type ProactiveComparisonRule } from '@flux/contracts';
import { request } from '../api/client';

/** The provider's models, listed by the Flux server without a key (F-020 PROV-1). */
export const listAiModels = (query: AiModelListQuery) => request<AiModelList>(AI_MODEL_LISTS_PATH, { method: 'POST', body: query });

export const currentBackgroundUsage = (signal?: AbortSignal) => request<BackgroundComputeUsage>(backgroundComputeUsagePath, { signal });

/** All of the owner's own connections, the background one first (F-020 PROV-1). */
export const listBackgroundConnections = (signal?: AbortSignal) => request<BackgroundComputeConnection[]>(backgroundComputeConnectionsPath, { signal });
export const markBackgroundConnection = (id: string) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'PATCH', body: { usedForBackground: true } });
export const connectBackgroundCompute = (command: ConnectBackgroundComputeCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionsPath, { method: 'POST', body: command });
export const revokeBackgroundConnection = (id: string) =>
  request<null>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'DELETE' });

const projectRules = (id: string) => proactiveComparisonRulesPath(encodeURIComponent(id));
export const listBackgroundRules = (projectId: string, signal?: AbortSignal) =>
  request<ProactiveComparisonRule[]>(projectRules(projectId), { signal });
export const createBackgroundRule = (projectId: string, command: CreateProactiveComparisonRule) =>
  request<ProactiveComparisonRule>(projectRules(projectId), { method: 'POST', body: command });
/** The one sentence for background suggestions when this server does not run them (#513): Agents and AI and their page. */
export const BACKGROUND_OFF_LINE = 'Off on this Flux server · not available until your admin turns it on';
/** Whether this instance runs background comparisons, so a rule can be enabled (#58). */
export const backgroundComparisonRuntime = (signal?: AbortSignal) =>
  request<BackgroundComparisonRuntime>(backgroundComparisonRuntimePath, { signal });
export const changeBackgroundRule = (rule: ProactiveComparisonRule, status: 'enabled' | 'paused' | 'revoked') =>
  request<ProactiveComparisonRule>(proactiveComparisonRulePath(encodeURIComponent(rule.id)),
    { method: 'PATCH', body: { expectedVersion: rule.version, status } });
