import {
  conversationMessagesPath, conversationPath, projectConversationRootsPath, projectConversationsPath, projectObjectNoticesPath, projectTaskNoticesPath, type Conversation, type ConversationMessage, type ConversationRootWindow, type ConversationSummary, type Page, type SendMessageCommand, type TaskCreationNotice, projectObservationsPath, projectReceiptsPath, type MessageReceiptsResult, type ObserveMessagesResult, type ObjectNotice,
} from '@flux/contracts';
import { request } from '../api/client';

/** The project conversation (#36, UI116): its roots, threads, replies, notices and viewing receipts. */
export const listConversations = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<ConversationSummary>>(`${projectConversationsPath(projectId)}?limit=100&offset=${offset}`, { signal });
/** The project's one stream (UI116-1): the newest roots, or those before a conversation id. */
export const listConversationRoots = (projectId: string, options: { before?: string | null; limit?: number } = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  if (options.limit) query.set('limit', String(options.limit));
  if (options.before) query.set('before', options.before);
  const search = query.toString();
  return request<ConversationRootWindow>(`${projectConversationRootsPath(projectId)}${search ? `?${search}` : ''}`, { signal });
};
/** The project's task announcements (UI116-3), newest first. */
export const listTaskNotices = (projectId: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
  request<Page<TaskCreationNotice>>(`${projectTaskNoticesPath(projectId)}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`, { signal });
/** The decisions and results the conversation announces (#694), newest first. */
export const listObjectNotices = (projectId: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
  request<Page<ObjectNotice>>(`${projectObjectNoticesPath(projectId)}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`, { signal });
export const getConversation = (id: string, signal?: AbortSignal) => request<Conversation>(conversationPath(id), { signal });
export const olderMessages = (id: string, beforeSequence: number, signal?: AbortSignal, limit?: number) =>
  request<Conversation>(`${conversationPath(id)}?beforeSequence=${beforeSequence}${limit ? `&limit=${limit}` : ''}`, { signal });
export const startConversation = (projectId: string, command: SendMessageCommand) => request<Conversation>(projectConversationsPath(projectId), { method: 'POST', body: command });
export const reply = (id: string, command: SendMessageCommand) => request<ConversationMessage>(conversationMessagesPath(id), { method: 'POST', body: command });
/** Viewing receipts of the project's conversation (#534): what this person saw, and who saw the runs of their own messages. */
export const observeProjectMessages = (projectId: string, messageIds: string[]) =>
  request<ObserveMessagesResult>(projectObservationsPath(projectId), { method: 'POST', body: { messageIds } });
export const projectReceipts = (projectId: string, runs: string[][], signal?: AbortSignal) =>
  request<MessageReceiptsResult>(projectReceiptsPath(projectId), { method: 'POST', body: { runs }, signal });
