import {
  IDEMPOTENCY_KEY_HEADER, dmLeavePath, dmMessagesPath, dmPath, workspaceDmsPath,
  type ConversationMessage, type Dm, type DmSummary, type Page, type SendDmMessageCommand, type Workspace, WORKSPACES_PATH,
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
export const olderDmMessages = (id: string, beforeSequence: number, signal?: AbortSignal) => request<Dm>(`${dmPath(id)}?beforeSequence=${beforeSequence}`, { signal });
export const sendDmMessage = (id: string, command: SendDmMessageCommand) => request<ConversationMessage>(dmMessagesPath(id), { method: 'POST', body: command });
export const leaveDm = (id: string) => request<null>(dmLeavePath(id), { method: 'POST' });
