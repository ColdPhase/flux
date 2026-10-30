import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from 'react-router';
import type { Conversation, ConversationRootWindow, Material, ObjectNotice, Page, Project, ProjectGoal, TaskCreationNotice, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { listMaterials } from '../materials/api';
import { getProject, listWorkspaceMembers } from '../project/api';
import { listProjectGoals } from '../project/goal';
import { getConversation, listConversationRoots, listObjectNotices, listTaskNotices } from './api';

/** The project's one conversation (UI116-1): the newest roots and task announcements (UI116-3), and the thread a URL opens. */
export interface ProjectData {
  project: Project; roots: ConversationRootWindow; notices: Page<TaskCreationNotice>; objectNotices: Page<ObjectNotice>; materials: Material[]; materialTotal: number; members: WorkspaceMember[]; conversation: Conversation | null;
  /** The project's reached goals (#520), each one entry in the stream at the moment it was reached. */
  goals: ProjectGoal[];
}
export async function projectConversationLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectData> {
  const projectId = params.projectId!;
  const project = await getProject(projectId, request.signal);
  // Work, decisions and results come with the project (#117 parent route).
  const [roots, notices, objectNotices, materials, members, goals] = await Promise.all([
    listConversationRoots(projectId, {}, request.signal),
    // Announcements add to the stream; a failure that is not about access leaves the stream readable without them.
    listTaskNotices(projectId, {}, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw error;
      return { items: [], total: 0, limit: 100, offset: 0 };
    }),
    // The same for the decisions and results the stream announces (#694).
    listObjectNotices(projectId, {}, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw error;
      return { items: [], total: 0, limit: 100, offset: 0 };
    }),
    listMaterials(projectId, request.signal),
    listWorkspaceMembers(project.workspaceId, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }),
    // Only a project that had a goal reads its history; the stream stays readable without it.
    project.goal ? listProjectGoals(projectId, request.signal).then((list) => list.items.filter((goal) => goal.reachedAt)).catch((error: unknown) => {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw error;
      return [];
    }) : Promise.resolve([]),
  ]);
  const conversation = params.conversationId ? await getConversation(params.conversationId, request.signal) : null;
  if (conversation && conversation.projectId !== projectId) throw new Response('Not found', { status: 404 });
  return { project, roots, notices, objectNotices, materials: materials.items, materialTotal: materials.total, members, conversation, goals };
}
/** The stream stays mounted while a thread opens or closes; its loader refreshes the open thread then. */
export function shouldRevalidateProjectConversation({ currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return defaultShouldRevalidate || currentParams.projectId !== nextParams.projectId || currentParams.conversationId !== nextParams.conversationId;
}
