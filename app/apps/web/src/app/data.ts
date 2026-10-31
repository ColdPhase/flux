import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { WorkspaceAiPolicy, WorkspaceRole } from '@flux/contracts';
import { getMe, type MeResponse } from '../api/auth';
import { signInPath } from '../auth/logic';
import { listAllDms } from '../api/direct-messages';
import { audienceLine, dmTitle, othersIn } from '../dm/names';
import { listAccessibleProjects } from '../project/api';
import type { WorkspaceEncryption } from '../encryption/api';

/**
 * Shapes the shell renders. Projects and direct messages come from the workspace, conversation
 * and direct-message APIs (#29, #36, #107); the loader never returns sample data. The administrative workspace is only a data boundary: nobody has to pick
 * or build one before ordinary work, so the shell shows it at most as a quiet name.
 */
export interface WorkspaceSummary {
  id: string; name: string;
  /** The person's role there (#188): owners and admins manage its people. */
  role?: WorkspaceRole | null;
  /** F-029 (#614): whether agents and assistants may work here; the whole interface there is human-only while blocked. */
  ai?: WorkspaceAiPolicy;
  /** F-030 (#655): null or absent for a plain workspace. A locked one is kept in `ShellData.lockedWorkspaces`. */
  encryption?: WorkspaceEncryption | null;
}
/** A small, audience-specific project. Only projects the person belongs to are ever listed. */
export interface ProjectSummary { id: string; name: string; workspaceId?: string; workspaceName?: string; hasNew?: boolean }
/** A private conversation with one or more people, independent of any project. */
export interface DirectMessageSummary {
  id: string; workspaceId: string; kind: 'pair' | 'group'; title: string; people: string[]; participantIds: string[];
  /** "Only you and Kai". */
  audience: string; preview: string | null; lastAt: string | null; hasNew?: boolean;
}

export interface ShellData {
  me: MeResponse;
  workspace: WorkspaceSummary | null;
  /** The workspaces whose content can be read now: plain ones and encrypted ones that are unlocked. */
  workspaces: WorkspaceSummary[];
  /** Encrypted workspaces that wait to be unlocked (F-030, #655): drawn as one row each, never asked for content. */
  lockedWorkspaces: WorkspaceSummary[];
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
}

/** The latest shell read, so a route loader can ask whether a project's workspace has AI off before it asks the server (#614). */
let latestShell: Promise<ShellData> | null = null;

/** True when the project's workspace has AI off, by the shell's latest read; false when that is not known. */
export async function projectAiBlocked(projectId: string | undefined): Promise<boolean> {
  try {
    const shell = await latestShell;
    const workspaceId = shell?.projects.find((project) => project.id === projectId)?.workspaceId;
    return shell?.workspaces.find((space) => space.id === workspaceId)?.ai?.state === 'blocked';
  } catch { return false; }
}

/** True when AI is off in every workspace of the person (and they have one), by the shell's latest read; false when that is not known. */
export async function allAiBlocked(): Promise<boolean> {
  try {
    const shell = await latestShell;
    // An encrypted workspace is always without AI, locked or not.
    return !!shell && shell.workspaces.length + shell.lockedWorkspaces.length > 0 && shell.workspaces.every((space) => space.ai?.state === 'blocked');
  } catch { return false; }
}

/** Auth guard: restores the session from its cookie on every full load, or sends the person to sign in. */
export function appLoader(args: LoaderFunctionArgs): Promise<ShellData> {
  const loading = readShell(args);
  latestShell = loading;
  return loading;
}

async function readShell({ request }: LoaderFunctionArgs): Promise<ShellData> {
  const me = await getMe(request.signal);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(signInPath(`${url.pathname}${url.search}`));
  }
  const { workspaces, lockedWorkspaces, projects } = await listAccessibleProjects(request.signal);
  const nameCounts = new Map<string, number>();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  const namedProjects = projects.map((project) => ({ ...project, workspaceName: nameCounts.get(project.name)! > 1 ? workspaces.find((space) => space.id === project.workspaceId)?.name : undefined }));
  const dms = await listAllDms(request.signal, workspaces);
  const directMessages = dms.map((dm) => ({
    id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, title: dmTitle(dm, me.user.id),
    people: othersIn(dm, me.user.id).map((person) => person.name), participantIds: dm.audience.participantIds,
    audience: audienceLine(dm, me.user.id), preview: dm.lastMessageBody, lastAt: dm.lastMessageAt,
  }));
  return { me, workspace: workspaces[0] ?? null, workspaces, lockedWorkspaces, projects: namedProjects, directMessages };
}

export function useShellData(): ShellData {
  return useRouteLoaderData('app') as ShellData;
}
