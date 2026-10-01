import {
  WORKSPACES_PATH, conversationMessagesPath, conversationPath, materialPath,
  materialVersionPath, projectConversationsPath, projectMaterialsPath, projectPath, workspaceProjectsPath,
  type Conversation, type ConversationMessage, type ConversationSummary, type CreateMaterialCommand,
  type Draft, type WorkspaceMember, type Material, type MaterialVersion, type Page, type Project, type SendMessageCommand, type Workspace, workspaceDraftsPath,
} from '@flux/contracts';
import { request } from '../api/client';

export async function listAccessibleProjects(signal?: AbortSignal) {
  const workspaces = await request<Workspace[]>(WORKSPACES_PATH, { signal });
  const projects: Project[] = [];
  for (const workspace of workspaces) {
    for (let offset = 0; ; offset += 100) {
      const page = await request<Page<Project>>(`${workspaceProjectsPath(workspace.id)}?limit=100&offset=${offset}`, { signal });
      projects.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
  }
  return { workspaces, projects };
}

export const createWorkspace = (name: string) => request<Workspace>(WORKSPACES_PATH, { method: 'POST', body: { name } });
export const createProject = (workspaceId: string, name: string) => request<Project>(workspaceProjectsPath(workspaceId), { method: 'POST', body: { name, visibility: 'restricted' } });
export const getProject = (id: string, signal?: AbortSignal) => request<Project>(projectPath(id), { signal });
export const listConversations = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<ConversationSummary>>(`${projectConversationsPath(projectId)}?limit=100&offset=${offset}`, { signal });
export const getConversation = (id: string, signal?: AbortSignal) => request<Conversation>(conversationPath(id), { signal });
export const olderMessages = (id: string, beforeSequence: number, signal?: AbortSignal, limit?: number) =>
  request<Conversation>(`${conversationPath(id)}?beforeSequence=${beforeSequence}${limit ? `&limit=${limit}` : ''}`, { signal });
export const startConversation = (projectId: string, command: SendMessageCommand) => request<Conversation>(projectConversationsPath(projectId), { method: 'POST', body: command });
export const reply = (id: string, command: SendMessageCommand) => request<ConversationMessage>(conversationMessagesPath(id), { method: 'POST', body: command });
export const listMaterials = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<Material>>(`${projectMaterialsPath(projectId)}?limit=100&offset=${offset}`, { signal });
export const publishMaterial = (projectId: string, command: CreateMaterialCommand) => request<Material>(projectMaterialsPath(projectId), { method: 'POST', body: command });
export const getMaterial = (id: string, signal?: AbortSignal) => request<Material>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });

export const listDrafts = (workspaceId: string, signal?: AbortSignal) => request<Page<Draft>>(`${workspaceDraftsPath(workspaceId)}?limit=100`, { signal });
export const createPrivateDraft = (workspaceId: string, title: string, body: string) => request<Draft>(workspaceDraftsPath(workspaceId), { method: 'POST', body: { title, body } });
export const listWorkspaceMembers = (workspaceId: string, signal?: AbortSignal) => request<WorkspaceMember[]>(`${WORKSPACES_PATH}/${workspaceId}/members`, { signal });
