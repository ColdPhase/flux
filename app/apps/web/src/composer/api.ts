import { agentChatFilesPath, dmFilesPath, projectFilesPath, taskDiscussionPath, type SentConversationMessage, type StagedFile, type TaskContributionCommand, type TaskDiscussion } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';

/** Every view sends the same task command through this operation, including conversation replies. */
export const getTaskDiscussion = (workId: string, options: { limit?: number; beforeSequence?: number; signal?: AbortSignal } = {}) => {
  const query = new URLSearchParams();
  if (options.limit) query.set('limit', String(options.limit));
  if (options.beforeSequence) query.set('beforeSequence', String(options.beforeSequence));
  return request<TaskDiscussion>(`${taskDiscussionPath(workId)}${query.size ? `?${query}` : ''}`, { signal: options.signal });
};
/** A message in a task's discussion; `answered` names what it answered in the person's Inbox (#1170). */
export const contributeToTask = (workId: string, command: TaskContributionCommand) =>
  request<SentConversationMessage>(taskDiscussionPath(workId), { method: 'POST', body: command });

/**
 * Raw authenticated bytes; upload UUID is retained after a lost response. It goes by XMLHttpRequest, the
 * only browser API that reports how many bytes of the upload have gone out (`onProgress`, 0 to 1, #348).
 */
/** The place a file is staged in: a space (its id), a direct message (#1438 point 10), or the private chat with one of your agents (C-64). */
export type FilePlace = string | { dmId: string } | { agentId: string };
const filesPath = (place: FilePlace) => typeof place === 'string' ? projectFilesPath(place) : 'dmId' in place ? dmFilesPath(place.dmId) : agentChatFilesPath(place.agentId);

export function stageFile(place: FilePlace, uploadId: string, file: File, onProgress?: (fraction: number) => void): Promise<StagedFile> {
  return new Promise<StagedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${filesPath(place)}?${new URLSearchParams({ uploadId, name: file.name })}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new NetworkError());
    xhr.ontimeout = () => reject(new NetworkError());
    xhr.onload = () => {
      type Answer = StagedFile & { code?: string; message?: string; error?: string };
      let data: Answer;
      try { data = JSON.parse(xhr.responseText) as Answer; } catch { reject(new ApiError(xhr.status, null, xhr.statusText)); return; }
      // The server says why in `error` ("A video is at most 200 MiB"), which is what the person should read.
      if (xhr.status < 200 || xhr.status >= 300) { reject(new ApiError(xhr.status, data.code ?? null, data.message ?? data.error ?? xhr.statusText, data)); return; }
      resolve(data);
    };
    xhr.send(file);
  });
}
