import { projectFilesPath, taskDiscussionPath, type ConversationMessage, type StagedFile, type TaskContributionCommand, type TaskDiscussion } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';

/** Every view sends the same task command through this operation, including conversation replies. */
export const getTaskDiscussion = (workId: string, options: { limit?: number; beforeSequence?: number; signal?: AbortSignal } = {}) => {
  const query = new URLSearchParams();
  if (options.limit) query.set('limit', String(options.limit));
  if (options.beforeSequence) query.set('beforeSequence', String(options.beforeSequence));
  return request<TaskDiscussion>(`${taskDiscussionPath(workId)}${query.size ? `?${query}` : ''}`, { signal: options.signal });
};
export const contributeToTask = (workId: string, command: TaskContributionCommand) =>
  request<ConversationMessage>(taskDiscussionPath(workId), { method: 'POST', body: command });

/** Raw authenticated bytes; upload UUID is retained after a lost response. */
export async function stageFile(projectId: string, uploadId: string, file: File): Promise<StagedFile> {
  let response: Response;
  try {
    response = await fetch(`${projectFilesPath(projectId)}?${new URLSearchParams({ uploadId, name: file.name })}`, {
      method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/octet-stream' }, body: file,
    });
  } catch { throw new NetworkError(); }
  const data = await response.json() as StagedFile & { code?: string; message?: string };
  if (!response.ok) throw new ApiError(response.status, data.code ?? null, data.message ?? response.statusText, data);
  return data;
}
