import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from 'react-router';
import type { Conversation, ConversationRootWindow, ObjectNotice, Page, Project, TaskCreationNotice, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { listWorkspaceMembers } from '../project/api';
import { spaceOf } from '../project/data';
import { getConversation, getConversationView } from './api';

/** The project's one conversation (UI116-1): the newest roots and task announcements (UI116-3), and the thread a URL opens. */
export interface ProjectData {
  project: Project; roots: ConversationRootWindow; notices: Page<TaskCreationNotice>; objectNotices: Page<ObjectNotice>; members: WorkspaceMember[]; conversation: Conversation | null;
}
export async function projectConversationLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectData> {
  const projectId = params.projectId!;
  // What the conversation shows comes in one read (#1109); the space is the one its frame is reading, or the kept one.
  const [project, view] = await Promise.all([spaceOf(projectId, request.signal), getConversationView(projectId, request.signal)]);
  const [members, conversation] = await Promise.all([
    listWorkspaceMembers(project.workspaceId, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }),
    params.conversationId ? getConversation(params.conversationId, request.signal) : null,
  ]);
  if (conversation && conversation.projectId !== projectId) throw new Response('Not found', { status: 404 });
  return { project, roots: view.roots, notices: view.taskNotices, objectNotices: view.objectNotices, members, conversation };
}
/** The stream stays mounted while a thread opens or closes; its loader refreshes the open thread then. */
export function shouldRevalidateProjectConversation({ currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return defaultShouldRevalidate || currentParams.projectId !== nextParams.projectId || currentParams.conversationId !== nextParams.conversationId;
}
