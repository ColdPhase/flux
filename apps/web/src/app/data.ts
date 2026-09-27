import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import { getMe, type MeResponse } from '../api/auth';
import { signInPath } from '../auth/logic';

/**
 * Shapes the shell renders. Projects and direct messages come from the workspace and
 * conversation APIs (#29 slice 2, #36); until they exist the loader returns honest empty lists,
 * never sample data. The administrative workspace is only a data boundary: nobody has to pick
 * or build one before ordinary work, so the shell shows it at most as a quiet name.
 */
export interface WorkspaceSummary { id: string; name: string }
/** A small, audience-specific project. Only projects the person belongs to are ever listed. */
export interface ProjectSummary { id: string; name: string; hasNew?: boolean }
/** A private conversation with one or more people, independent of any project. */
export interface DirectMessageSummary { id: string; title: string; people: string[]; hasNew?: boolean }

export interface ShellData {
  me: MeResponse;
  workspace: WorkspaceSummary | null;
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
  return { me, workspace: null, projects: [], directMessages: [] };
}

export function useShellData(): ShellData {
  return useRouteLoaderData('app') as ShellData;
}
