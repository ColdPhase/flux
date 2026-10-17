import {
  IDEMPOTENCY_KEY_HEADER, dmLeavePath, dmMessagesPath, dmObservationsPath, dmPath, dmReceiptsPath, dmRepliesPath, dmTaskCopiesPath, dmTaskCopyPreviewPath, dmThreadPath, workspaceDmsPath,
  type Dm, type DmMessage, type DmSummary, type DmTaskCopyPreview, type DmTaskCopyPreviewCommand, type DmTaskCopyResult, type DmThread,
  type MessageReceiptsResult, type ObserveMessagesResult, type Page, type SendDmMessageCommand, type Workspace, WORKSPACES_PATH,
} from '@flux/contracts';
import { request } from './client';

/** Direct messages (#107): private conversations with people, outside any project. */
export async function listAllDms(signal?: AbortSignal, workspaces?: Workspace[]) {
  const spaces = workspaces ?? await request<Workspace[]>(WORKSPACES_PATH, { signal });
  const items: DmSummary[] = [];
  for (const space of spaces) {
    for (let offset = 0; ; offset += 100) {
      const page = await request<Page<DmSummary>>(`${workspaceDmsPath(space.id)}?limit=100&offset=${offset}`, { signal });
      items.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
  }
  return items.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}

/** Opens the 1:1 DM with one person (created once, then reused) or starts a group DM. */
export const openDm = (workspaceId: string, participantIds: string[], idempotencyKey: string, title?: string) =>
  request<Dm>(workspaceDmsPath(workspaceId), { method: 'POST', body: { participantIds, ...(title ? { title } : {}) }, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
export const getDm = (id: string, signal?: AbortSignal) => request<Dm>(dmPath(id), { signal });
export const olderDmMessages = (id: string, beforeSequence: number, signal?: AbortSignal, limit?: number) =>
  request<Dm>(`${dmPath(id)}?beforeSequence=${beforeSequence}${limit ? `&limit=${limit}` : ''}`, { signal });
export const sendDmMessage = (id: string, command: SendDmMessageCommand) => request<DmMessage>(dmMessagesPath(id), { method: 'POST', body: command });
/** A private reply (#536): the thread of one root, readable by the DM's current participants only. */
export const getDmThread = (id: string, rootId: string, signal?: AbortSignal) => request<DmThread>(dmThreadPath(id, rootId), { signal });
export const olderDmReplies = (id: string, rootId: string, beforeSequence: number, signal?: AbortSignal) =>
  request<DmThread>(`${dmThreadPath(id, rootId)}?beforeSequence=${beforeSequence}`, { signal });
export const sendDmReply = (id: string, rootId: string, command: SendDmMessageCommand) => request<DmMessage>(dmRepliesPath(id, rootId), { method: 'POST', body: command });
/** Viewing receipts (#534): what this person saw, and who saw the runs of their own messages. */
export const observeDmMessages = (id: string, messageIds: string[]) => request<ObserveMessagesResult>(dmObservationsPath(id), { method: 'POST', body: { messageIds } });
export const dmReceipts = (id: string, runs: string[][], signal?: AbortSignal) => request<MessageReceiptsResult>(dmReceiptsPath(id), { method: 'POST', body: { runs }, signal });
/** An explicit excerpt copy into a project task (#537). */
export const previewDmTaskCopy = (id: string, body: DmTaskCopyPreviewCommand, signal?: AbortSignal) => request<DmTaskCopyPreview>(dmTaskCopyPreviewPath(id), { method: 'POST', body, signal });
export const copyDmToTask = (id: string, body: { messageId: string; excerpt: string; projectId: string; token: string; clientCommandId: string }, idempotencyKey: string) =>
  request<DmTaskCopyResult>(dmTaskCopiesPath(id), { method: 'POST', body, headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });
export const leaveDm = (id: string) => request<null>(dmLeavePath(id), { method: 'POST' });
