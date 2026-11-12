import { AI_MODEL_LISTS_PATH, backgroundComputeConnectionPath, backgroundComputeConnectionsPath, backgroundComputeModelListPath, backgroundComputeModelPricePath,
  type AiModelList, type AiModelListQuery, type AssistantModelListing, type BackgroundComputeConnection, type SetApiKeyModelPriceCommand, type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand } from '@flux/contracts';
import { request } from '../api/client';

/** The provider's models, listed by the Flux server: without a key, or with the key being added, which is its test (CA-2, #1218). */
export const listAiModels = (query: AiModelListQuery) => request<AiModelList>(AI_MODEL_LISTS_PATH, { method: 'POST', body: query });

/** All of the owner's own API keys, newest first (F-020 PROV-1). */
export const listBackgroundConnections = (signal?: AbortSignal) => request<BackgroundComputeConnection[]>(backgroundComputeConnectionsPath, { signal });
export const updateBackgroundConnection = (id: string, change: UpdateBackgroundComputeConnectionCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'PATCH', body: change });
export const connectBackgroundCompute = (command: ConnectBackgroundComputeCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeConnectionsPath, { method: 'POST', body: command });
export const revokeBackgroundConnection = (id: string) =>
  request<null>(backgroundComputeConnectionPath(encodeURIComponent(id)), { method: 'DELETE' });
/** The owner's price for one of their key's models that Flux's table does not price (#1218). */
export const setKeyModelPrice = (id: string, command: SetApiKeyModelPriceCommand) =>
  request<BackgroundComputeConnection>(backgroundComputeModelPricePath(encodeURIComponent(id)), { method: 'PUT', body: command });
/** Try again: the server reads the key's models from its provider again and says how fresh its list is now (#1218). */
export const readKeyModelsAgain = (id: string) =>
  request<{ listing: AssistantModelListing | null }>(backgroundComputeModelListPath(encodeURIComponent(id)), { method: 'POST' });
