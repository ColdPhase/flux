import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import { ME_PROBE_HEADER, WORKSPACES_PATH, plainMessageText, type MyAgent, type ProjectAccess, type ProjectVisibility, type SpaceAiState, type WorkspaceRole } from '@flux/contracts';
import { request as apiRead } from '../api/client';
import { getMe, type MeResponse } from '../api/auth';
import { pacedShellRead } from './shellPace';
import { forgetKeptPages } from './keepPage';
import { keepTimeZone } from './timeZone';
import { signInPath } from '../auth/logic';
import { listAllDms } from '../api/direct-messages';
import { listMyAgents } from '../my-agents/api';
import { audienceLine, dmTitle, othersIn } from '../dm/names';
import { listAccessibleProjects } from '../project/api';
import type { EncryptedWorkspace, WorkspaceEncryption } from '../encryption/api';
import { readPeoplePhotos } from '../people/photos';

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
  /** F-030 (#655): null or absent for a plain workspace. A locked one is kept in `ShellData.lockedWorkspaces`. */
  encryption?: WorkspaceEncryption | null;
  /** F-037, F-030 (#874): the company this encrypted workspace is a space of (an internal workspace people see as the space it holds), or null. */
  spaceOf?: string | null;
}
/** A space (a project internally). `member` is false only where a company owner or admin reaches a space they are not in (F-037). */
export interface ProjectSummary {
  id: string; name: string; workspaceId?: string; hasNew?: boolean; member?: boolean;
  /** The person's access to the space: a space admin, or a company owner or admin, is a manager. */
  access?: ProjectAccess;
  /** `workspace` is the Everyone space, which holds the whole company. */
  visibility?: ProjectVisibility;
  /** AG-10: whether agents may work in this space; the space is human-only while `blocked`. */
  ai?: SpaceAiState;
}
/** A private conversation with one or more people, independent of any project. */
export interface DirectMessageSummary {
  id: string; workspaceId: string; kind: 'pair' | 'group'; title: string; people: string[];
  /** The user ids of `people`, in the same order (their avatars' photos, F-039). */
  peopleIds: string[]; participantIds: string[];
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
  /** The person's own agents, oldest first: the first is Assistant, pinned first in Messages (F-036 AG-1). */
  agents: MyAgent[];
  /** User id → photo id of the people this person can see (F-039): every avatar of one of them draws the photo. */
  photos: Record<string, string>;
}

/** The latest shell read, so a route loader can ask whether a space has AI off before it asks the server (#614). */
let latestShell: Promise<ShellData> | null = null;

/** True when the space has AI off, by the shell's latest read; false when that is not known. */
export async function projectAiBlocked(projectId: string | undefined): Promise<boolean> {
  try {
    const shell = await latestShell;
    return shell?.reachableSpaces.find((project) => project.id === projectId)?.ai === 'blocked';
  } catch { return false; }
}

/** True when AI is off in every space of the person (and they have one), by the shell's latest read; false when that is not known. */
export async function allAiBlocked(): Promise<boolean> {
  try {
    const shell = await latestShell;
    return !!shell && shell.projects.length > 0 && shell.projects.every((space) => space.ai === 'blocked');
  } catch { return false; }
}

/** Auth guard: restores the session from its cookie on every full load, or sends the person to sign in. */
export function appLoader(args: LoaderFunctionArgs): Promise<ShellData> {
  // Paced (#1126): a page that navigates or revalidates in a loop, or whose reads keep failing, does not read the shell in a loop.
  const loading = pacedShellRead(args.request.signal, () => readShell(args));
  latestShell = loading;
  return loading;
}

async function readShell({ request }: LoaderFunctionArgs): Promise<ShellData> {
  // The person and the workspaces are read beside each other, then the projects and the conversations of every workspace beside each
  // other: two round trips before the shell, not four in a row (#850, #862). Without a session both answer a 200 `null`, as the probe
  // header asks, not a 401 that the browser console logs (#546); the person is sent to sign in.
  // The photos are read beside them (F-039): no round trip of their own, and a failure only leaves everyone with initials.
  const [me, read, photos] = await Promise.all([getMe(request.signal),
    apiRead<EncryptedWorkspace[] | null>(WORKSPACES_PATH, { signal: request.signal, headers: { [ME_PROBE_HEADER]: '1' } }).catch(() => null),
    readPeoplePhotos(request.signal).catch((): Record<string, string> => ({}))]);
  if (!me) {
    // No session: no page that was shown for one is kept for the next person who signs in here (#1141).
    forgetKeptPages();
    const url = new URL(request.url);
    throw redirect(signInPath(`${url.pathname}${url.search}`));
  }
  keepTimeZone(me);
  const all = read ?? await apiRead<EncryptedWorkspace[]>(WORKSPACES_PATH, { signal: request.signal });
  const [{ workspaces, lockedWorkspaces, projects: reachableSpaces }, dms, agents] = await Promise.all([
    listAccessibleProjects(request.signal, all),
    // A workspace that locked since this read answers its conversations with a refusal that is ignored (F-030, #655).
    listAllDms(request.signal, all.filter((workspace) => workspace.encryption?.state !== 'locked')),
    listMyAgents(request.signal).catch((): MyAgent[] => []),
  ]);
  const projects = reachableSpaces.filter((project) => project.member !== false);
  const directMessages = dms.map((dm) => ({
    id: dm.id, workspaceId: dm.workspaceId, kind: dm.kind, title: dmTitle(dm, me.user.id),
    people: othersIn(dm, me.user.id).map((person) => person.name), peopleIds: othersIn(dm, me.user.id).map((person) => person.id), participantIds: dm.audience.participantIds,
    audience: audienceLine(dm, me.user.id), preview: dm.lastMessageBody && dm.lastMessageVia ? `via ${dm.lastMessageVia}: ${plainMessageText(dm.lastMessageBody)}` : dm.lastMessageBody && plainMessageText(dm.lastMessageBody), lastAt: dm.lastMessageAt,
  }));
  return { me, workspace: workspaces.find((space) => space.company) ?? workspaces.find((space) => !space.spaceOf && !space.encryption) ?? workspaces[0] ?? null, workspaces, lockedWorkspaces, projects, reachableSpaces, directMessages, agents, photos };
}

export function useShellData(): ShellData {
  return useRouteLoaderData('app') as ShellData;
}
