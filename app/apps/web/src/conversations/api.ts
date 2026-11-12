import {
  conversationMessagePath, conversationMessagesPath, conversationPath, projectConversationRootsPath, projectConversationsPath, projectObjectNoticesPath, projectTaskNoticesPath, type Conversation, type ConversationMessage, type ConversationRootWindow, type ConversationSummary, type Page, type SendMessageCommand, type SentConversationMessage, type TaskCreationNotice, projectObservationsPath, projectReadersPath, projectReceiptsPath, type MessageReadersResult, type MessageReceiptsResult, type ObserveMessagesResult, type ObjectNotice, type MessagePlace, projectMessagePlacePath, projectAgentQuestionsPath, projectConversationViewPath, type ConversationView,
} from '@flux/contracts';
import { request } from '../api/client';
import { workAssociationReadUrl } from '../work/read-api';

/** The project conversation (#36, UI116): its roots, threads, replies, notices and viewing receipts. */
export const listConversations = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<ConversationSummary>>(`${projectConversationsPath(projectId)}?limit=100&offset=${offset}`, { signal });
/**
 * What the space's Conversation shows when it opens, in one read (#1109): its newest roots, notices and sources. The agents' questions
 * and the first work associations of the roots answer the stream's own first reads of them (`parts`), which are then not requests.
 */
export const getConversationView = (projectId: string, signal?: AbortSignal) => request<ConversationView>(projectConversationViewPath(projectId), {
  signal,
  parts: (view: ConversationView) => ({
    [projectAgentQuestionsPath(projectId)]: view.agentQuestions,
    ...(view.workAssociations?.sources.length ? {
      [workAssociationReadUrl(projectId, { messageIds: view.workAssociations.sources.map((source) => source.messageId).join(','), relation: 'source' })]: view.workAssociations,
    } : {}),
  }),
});
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
/** The decisions the conversation announces (#694), newest first. */
export const listObjectNotices = (projectId: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
  request<Page<ObjectNotice>>(`${projectObjectNoticesPath(projectId)}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`, { signal });
export const getConversation = (id: string, signal?: AbortSignal) => request<Conversation>(conversationPath(id), { signal });
export const olderMessages = (id: string, beforeSequence: number, signal?: AbortSignal, limit?: number) =>
  request<Conversation>(`${conversationPath(id)}?beforeSequence=${beforeSequence}${limit ? `&limit=${limit}` : ''}`, { signal });
export const startConversation = (projectId: string, command: SendMessageCommand) => request<Conversation>(projectConversationsPath(projectId), { method: 'POST', body: command });
/** A reply; `answered` names what it answered in the person's Inbox (#1170). */
export const reply = (id: string, command: SendMessageCommand) => request<SentConversationMessage>(conversationMessagesPath(id), { method: 'POST', body: command });
/** The author changes the words of their own message in place, or deletes it (#1006); the server refuses anyone else. */
export const editMessage = (conversationId: string, messageId: string, body: string) =>
  request<ConversationMessage>(conversationMessagePath(conversationId, messageId), { method: 'PATCH', body: { body } });
export const removeMessage = (conversationId: string, messageId: string) =>
  request<ConversationMessage>(conversationMessagePath(conversationId, messageId), { method: 'DELETE' });
/** Viewing receipts of the project's conversation (#534): what this person saw, and who saw the runs of their own messages. */
export const observeProjectMessages = (projectId: string, messageIds: string[]) =>
  request<ObserveMessagesResult>(projectObservationsPath(projectId), { method: 'POST', body: { messageIds } });
export const projectReceipts = (projectId: string, runs: string[][], signal?: AbortSignal) =>
  request<MessageReceiptsResult>(projectReceiptsPath(projectId), { method: 'POST', body: { runs }, signal, leavesReads: true });
/** One page of the readers of one run, when a person opens the list (#1231). The runs are the ones the receipts were read for. */
export const projectReaders = (projectId: string, runs: string[][], run: number, after: string | undefined, signal?: AbortSignal) =>
  request<MessageReadersResult>(projectReadersPath(projectId), { method: 'POST', body: { runs, run, ...(after ? { after } : {}) }, signal, leavesReads: true });
/** The conversation a project message belongs to (CW-2), for a link that knows only the message. */
export const getMessagePlace = (projectId: string, messageId: string, signal?: AbortSignal) =>
  request<MessagePlace>(projectMessagePlacePath(encodeURIComponent(projectId), encodeURIComponent(messageId)), { signal });
/** A link to one project message by its id alone; the route below finds its thread. */
export const projectMessageHref = (projectId: string, messageId: string) => `/projects/${projectId}/messages/${messageId}`;
