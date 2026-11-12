import { useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import {
  SPACE_SHELL_LIMITS, projectDocsPath, projectPath, projectPeoplePath, projectSpaceShellPath, projectWorkSummaryPath, workspaceSketchesPath,
  type DocSummary, type Project, type ProjectPerson, type Sketch, type SketchPage, type SpaceShell,
} from '@flux/contracts';
import { KEEP_MS, request } from '../api/client';
import './project.css';
import { getProject } from './api';
import { listProjectDocs } from '../docs/api';

/**
 * What every view of one project shares: the project, its audience, and the
 * project's sketches and docs (the tab counts and Details). Loaded once by the parent route, so switching
 * between Conversation · Tasks · Map · Docs never re-fetches it; `revalidate()` refreshes it.
 */
export interface ProjectShell {
  project: Project;
  people: ProjectPerson[] | null;
  sketches: { items: Sketch[]; total: number } | null;
  /** The project's docs (#112), newest change first; null when they could not be read. */
  docs: DocSummary[] | null;
}

export const listProjectPeople = (projectId: string, signal?: AbortSignal) => request<ProjectPerson[]>(projectPeoplePath(projectId), { signal, share: true, keep: KEEP_MS });
/** A project's sketches, without empty ones (#508): the Map index, Details and the pickers list only sketches with something on them. */
export const listProjectSketches = (workspaceId: string, projectId: string, limit: number, offset: number, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=${limit}&offset=${offset}&projectId=${encodeURIComponent(projectId)}&hideEmpty=true`, { signal });
export const createProjectSketch = (workspaceId: string, projectId: string, title: string, idempotencyKey: string) =>
  request<Sketch>(workspaceSketchesPath(workspaceId), { method: 'POST', body: { title, scope: 'project', projectId }, headers: { 'idempotency-key': idempotencyKey } });

/**
 * The space's frame in one read (#1109). It is never a kept answer (#862, #592): the person may have lost the space in a way that sends
 * their tab no event (removed from the company, or from an encrypted space), so entering reads it. Its parts answer the next read of
 * their own addresses once (the space, its people, its first page of pages, its work summary), so the views that ask for them later
 * take them from here.
 */
const getSpaceShell = (projectId: string, signal?: AbortSignal) => request<SpaceShell>(projectSpaceShellPath(projectId), {
  signal, fresh: true,
  parts: (shell: SpaceShell) => ({
    [projectPath(projectId)]: shell.project,
    [projectPeoplePath(projectId)]: shell.people,
    [`${projectDocsPath(projectId)}?limit=${SPACE_SHELL_LIMITS.docs}&offset=0`]: shell.docs,
    [projectWorkSummaryPath(encodeURIComponent(projectId))]: shell.workSummary,
  }),
});

/** The shell of each space being entered, while it is read: the Conversation's loader, which runs beside it, takes the space from it. */
const entering = new Map<string, Promise<SpaceShell>>();

/** The space a view's loader shows: the one being entered when the frame is being read, or the kept one (#862). */
export function spaceOf(projectId: string, signal?: AbortSignal): Promise<Project> {
  const shell = entering.get(projectId);
  return shell ? shell.then((read) => read.project) : getProject(projectId, signal);
}

export async function projectShellLoader({ params, request: req }: LoaderFunctionArgs): Promise<ProjectShell> {
  const projectId = params.projectId!;
  // Registered before anything is awaited, so a view's loader started in the same navigation finds it.
  const reading = getSpaceShell(projectId, req.signal);
  entering.set(projectId, reading);
  let shell: SpaceShell;
  try { shell = await reading; } finally { if (entering.get(projectId) === reading) entering.delete(projectId); }
  // The audience, sketches and pages are context: without them the space still opens. More than a page of pages is read on.
  const docs = !shell.docs ? null : shell.docs.total > shell.docs.items.length ? await listProjectDocs(projectId, req.signal).catch(() => null) : shell.docs.items;
  return {
    project: shell.project,
    people: shell.people,
    sketches: shell.sketches ? { items: shell.sketches.items, total: shell.sketches.total } : null,
    docs: docs ? [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : null,
  };
}

export function useProjectShell(): ProjectShell | undefined {
  return useRouteLoaderData('project') as ProjectShell | undefined;
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

function join(names: string[]) {
  return names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The people a space was added to, in words: "You", "Kai and you", "Ari, Nia and you", "Ari, Nia, you and 4 others". Agents with access
 * are named as a count so they are never hidden. It says no "only": the company's owners and admins can open every space too, and the
 * space's details say so once (#1110). "you" is there only when the person is one of them: a company owner or admin who was not added
 * reads the names alone.
 */
export function audienceLine(people: ProjectPerson[] | null, meId: string): string {
  if (!people) return 'People with space access';
  const meIn = people.some((person) => person.kind === 'human' && person.id === meId);
  const others = people.filter((person) => person.kind === 'human' && person.id !== meId).map((person) => firstName(person.name));
  const agents = people.filter((person) => person.kind === 'agent').length;
  const named = others.length <= 3 ? join(meIn ? [...others, 'you'] : others)
    : `${others.slice(0, 2).join(', ')}${meIn ? ', you' : ''} and ${others.length - 2} others`;
  const humans = !named ? 'Nobody yet' : named === 'you' ? 'You' : named;
  return agents ? `${humans} · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : humans;
}
