import { AI_MODEL_LISTS_PATH, backgroundComparisonRuntimePath, backgroundComputeUsagePath, type AiModelList, type AiModelListQuery,
  type BackgroundComparisonRuntime, type BackgroundComputeConnection, type BackgroundComputeUsage, type ConnectBackgroundComputeCommand, type CreateProactiveComparisonRule, type ProactiveComparisonRule } from '@flux/contracts';
import { request } from '../api/client';

/** The provider's models, listed by the Flux server without a key (F-020 PROV-1). */
export const listAiModels = (query: AiModelListQuery) => request<AiModelList>(AI_MODEL_LISTS_PATH, { method: 'POST', body: query });

const connections = '/api/v1/background-compute-connections';
export const currentBackgroundUsage = (signal?: AbortSignal) => request<BackgroundComputeUsage>(backgroundComputeUsagePath, { signal });

/** All of the owner's own connections, the background one first (F-020 PROV-1). */
export const listBackgroundConnections = (signal?: AbortSignal) => request<BackgroundComputeConnection[]>(connections, { signal });
export const markBackgroundConnection = (id: string) =>
  request<BackgroundComputeConnection>(`${connections}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { usedForBackground: true } });
export const connectBackgroundCompute = (command: ConnectBackgroundComputeCommand) =>
  request<BackgroundComputeConnection>(connections, { method: 'POST', body: command });
export const revokeBackgroundConnection = (id: string) =>
  request<null>(`${connections}/${encodeURIComponent(id)}`, { method: 'DELETE' });

const projectRules = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}/proactive-comparison-rules`;
export const listBackgroundRules = (projectId: string, signal?: AbortSignal) =>
  request<ProactiveComparisonRule[]>(projectRules(projectId), { signal });
export const createBackgroundRule = (projectId: string, command: CreateProactiveComparisonRule) =>
  request<ProactiveComparisonRule>(projectRules(projectId), { method: 'POST', body: command });
/** Whether this instance runs background comparisons, so a rule can be enabled (#58). */
export const backgroundComparisonRuntime = (signal?: AbortSignal) =>
  request<BackgroundComparisonRuntime>(backgroundComparisonRuntimePath, { signal });
export const changeBackgroundRule = (rule: ProactiveComparisonRule, status: 'enabled' | 'paused' | 'revoked') =>
  request<ProactiveComparisonRule>(`/api/v1/proactive-comparison-rules/${encodeURIComponent(rule.id)}`,
    { method: 'PATCH', body: { expectedVersion: rule.version, status } });
