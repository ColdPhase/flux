import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { WorkspaceAiPolicy, WorkspaceRole } from '@flux/contracts';
import { getMe, type MeResponse } from '../api/auth';
import { signInPath } from '../auth/logic';
import { listAllDms } from '../api/direct-messages';
import { audienceLine, dmTitle, othersIn } from '../dm/names';
import { listAccessibleProjects } from '../project/api';
import type { WorkspaceEncryption } from '../encryption/api';

/**
 * Shapes the shell renders. Projects (spaces) and direct messages come from the workspace, conversation
 * and direct-message APIs (#29, #36, #107); the loader never returns sample data. F-037 (#874): one Flux is one company,
 * its one workspace; nobody picks or makes a workspace, and the shell shows its spaces as one flat list.
 */
export interface WorkspaceSummary {
  id: string; name: string;
  /** The company (F-037); a test deployment may also hold isolated workspaces. */
  company?: boolean;
  /** The person's role there (#188): owners and admins manage its people. */
  role?: WorkspaceRole | null;
  /** F-029 (#614): whether agents and assistants may work here; the whole interface there is human-only while blocked. */
  ai?: WorkspaceAiPolicy;
  /** F-030 (#655): null or absent for a plain workspace. A locked one is kept in `ShellData.lockedWorkspaces`. */
  encryption?: WorkspaceEncryption | null;
}
/** A space (a project internally). `member` is false only where a company owner or admin reaches a space they are not in (F-037). */
export interface ProjectSummary { id: string; name: string; workspaceId?: string; hasNew?: boolean; member?: boolean }
/** A private conversation with one or more people, independent of any project. */
export interface DirectMessageSummary {
  id: string; workspaceId: string; kind: 'pair' | 'group'; title: string; people: string[]; participantIds: string[];
  /** "Only you and Kai". */
  audience: string; preview: string | null; lastAt: string | null; hasNew?: boolean;
}

export interface ShellData {
  me: MeResponse;
  /** The company (F-037), or null for an account nobody has invited yet. */
  workspace: WorkspaceSummary | null;
  /** The workspaces whose content can be read now: plain ones and encrypted ones that are unlocked. */
  workspaces: WorkspaceSummary[];
  /** Encrypted workspaces that wait to be unlocked (F-030, #655): drawn as one row each, never asked for content. */
  lockedWorkspaces: WorkspaceSummary[];
  /** The spaces the person belongs to: everything that lists spaces lists these (F-037). */
  projects: ProjectSummary[];
  /** Every space they can open. A company owner or admin reaches more than they belong to: Settings › Company lists those. */
  reachableSpaces: ProjectSummary[];
  directMessages: DirectMessageSummary[];
}

/** The latest shell read, so a route loader can ask whether a project's workspace has AI off before it asks the server (#614). */
let latestShell: Promise<ShellData> | null = null;

/** True when the project's workspace has AI off, by the shell's latest read; false when that is not known. */
export async function projectAiBlocked(projectId: string | undefined): Promise<boolean> {
  try {
    const shell = await latestShell;
    const workspaceId = shell?.reachableSpaces.find((project) => project.id === projectId)?.workspaceId;
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
  const { workspaces, lockedWorkspaces, projects: reachableSpaces } = await listAccessibleProjects(request.signal);
  const projects = reachableSpaces.filter((project) => project.member !== false);
  const dms = await listAllDms(request.signal, workspaces);
  const directMessages = dms.map((dm) => ({
    id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, title: dmTitle(dm, me.user.id),
    people: othersIn(dm, me.user.id).map((person) => person.name), participantIds: dm.audience.participantIds,
    audience: audienceLine(dm, me.user.id), preview: dm.lastMessageBody, lastAt: dm.lastMessageAt,
  }));
  return { me, workspace: workspaces.find((space) => space.company) ?? workspaces[0] ?? null, workspaces, lockedWorkspaces, projects, reachableSpaces, directMessages };
}

export function useShellData(): ShellData {
  return useRouteLoaderData('app') as ShellData;
}
