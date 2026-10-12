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

/**
 * Raw authenticated bytes; upload UUID is retained after a lost response. It goes by XMLHttpRequest, the
 * only browser API that reports how many bytes of the upload have gone out (`onProgress`, 0 to 1, #348).
 */
export function stageFile(projectId: string, uploadId: string, file: File, onProgress?: (fraction: number) => void): Promise<StagedFile> {
  return new Promise<StagedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${projectFilesPath(projectId)}?${new URLSearchParams({ uploadId, name: file.name })}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new NetworkError());
    xhr.ontimeout = () => reject(new NetworkError());
    xhr.onload = () => {
      let data: StagedFile & { code?: string; message?: string };
      try { data = JSON.parse(xhr.responseText) as StagedFile & { code?: string; message?: string }; } catch { reject(new ApiError(xhr.status, null, xhr.statusText)); return; }
      if (xhr.status < 200 || xhr.status >= 300) { reject(new ApiError(xhr.status, data.code ?? null, data.message ?? xhr.statusText, data)); return; }
      resolve(data);
    };
    xhr.send(file);
  });
}
