import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { WorkspaceRole } from '@flux/contracts';
import { getMe, type MeResponse } from '../api/auth';
import { signInPath } from '../auth/logic';
import { listAllDms } from '../api/direct-messages';
import { audienceLine, dmTitle, othersIn } from '../dm/names';
import { listAccessibleProjects } from './conversation-api';

/**
 * Shapes the shell renders. Projects and direct messages come from the workspace, conversation
 * and direct-message APIs (#29, #36, #107); the loader never returns sample data. The administrative workspace is only a data boundary: nobody has to pick
 * or build one before ordinary work, so the shell shows it at most as a quiet name.
 */
export interface WorkspaceSummary {
  id: string; name: string;
  /** The person's role there (#188): owners and admins manage its people. */
  role?: WorkspaceRole | null;
}
/** A small, audience-specific project. Only projects the person belongs to are ever listed. */
export interface ProjectSummary { id: string; name: string; workspaceName?: string; hasNew?: boolean; /** What the project is for (#272 FF-6). */ goal?: string | null }
/** A private conversation with one or more people, independent of any project. */
export interface DirectMessageSummary {
  id: string; workspaceId: string; kind: 'pair' | 'group'; title: string; people: string[]; participantIds: string[];
  /** "Only you and Kai". */
  audience: string; preview: string | null; lastAt: string | null; hasNew?: boolean;
}

export interface ShellData {
  me: MeResponse;
  workspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
}

/** Auth guard: restores the session from its cookie on every full load, or sends the person to sign in. */
export async function appLoader({ request }: LoaderFunctionArgs): Promise<ShellData> {
  const me = await getMe(request.signal);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(signInPath(`${url.pathname}${url.search}`));
  }
  const { workspaces, projects } = await listAccessibleProjects(request.signal);
  const nameCounts = new Map<string, number>();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  const namedProjects = projects.map((project) => ({ ...project, workspaceName: nameCounts.get(project.name)! > 1 ? workspaces.find((space) => space.id === project.workspaceId)?.name : undefined }));
  const dms = await listAllDms(request.signal, workspaces);
  const directMessages = dms.map((dm) => ({
    id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, title: dmTitle(dm, me.user.id),
    people: othersIn(dm, me.user.id).map((person) => person.name), participantIds: dm.audience.participantIds,
    audience: audienceLine(dm, me.user.id), preview: dm.lastMessageBody, lastAt: dm.lastMessageAt,
  }));
  return { me, workspace: workspaces[0] ?? null, workspaces, projects: namedProjects, directMessages };
}

export function useShellData(): ShellData {
  return useRouteLoaderData('app') as ShellData;
}
