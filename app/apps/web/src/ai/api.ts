import { AI_MODEL_LISTS_PATH, backgroundComputeConnectionPath, backgroundComputeConnectionsPath, type AiModelList, type AiModelListQuery,
  type BackgroundComputeConnection, type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { request } from '../api/client';

/** The provider's models, listed by the Flux server without a key (F-020 PROV-1). */
export const listAiModels = (query: AiModelListQuery) => request<AiModelList>(AI_MODEL_LISTS_PATH, { method: 'POST', body: query });

/** All of the owner's own API keys, newest first (F-020 PROV-1). */
export const listBackgroundConnections = (signal?: AbortSignal) => request<BackgroundComputeConnection[]>(backgroundComputeConnectionsPath, { signal });
export const updateBackgroundConnection = (id: string, change: UpdateBackgroundComputeConnectionCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'PATCH', body: change });
export const connectBackgroundCompute = (command: ConnectBackgroundComputeCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionsPath, { method: 'POST', body: command });
export const revokeBackgroundConnection = (id: string) =>
  request<null>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'DELETE' });
