import { useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';
import { PROJECT_VIEWS, projectPeoplePath, workspaceSketchesPath, type DocSummary, type Project, type ProjectPerson, type ProjectViewId, type Sketch, type SketchPage } from '@flux/contracts';
import { request } from '../api/client';
import './project.css';
import { getProject } from '../app/conversation-api';
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

export const listProjectPeople = (projectId: string, signal?: AbortSignal) => request<ProjectPerson[]>(projectPeoplePath(projectId), { signal });
export const listProjectSketches = (workspaceId: string, projectId: string, limit: number, offset: number, signal?: AbortSignal) =>
  request<SketchPage>(`${workspaceSketchesPath(workspaceId)}?limit=${limit}&offset=${offset}&projectId=${encodeURIComponent(projectId)}`, { signal });
export const createProjectSketch = (workspaceId: string, projectId: string, title: string, idempotencyKey: string) =>
  request<Sketch>(workspaceSketchesPath(workspaceId), { method: 'POST', body: { title, scope: 'project', projectId }, headers: { 'idempotency-key': idempotencyKey } });

export async function projectShellLoader({ params, request: req }: LoaderFunctionArgs): Promise<ProjectShell> {
  const project = await getProject(params.projectId!, req.signal);
  // The audience, sketches and docs are context: without them the project still opens.
  const [people, sketches, docs] = await Promise.all([
    listProjectPeople(project.id, req.signal).catch(() => null),
    listProjectSketches(project.workspaceId, project.id, 20, 0, req.signal).then((page) => ({ items: page.items, total: page.total })).catch(() => null),
    listProjectDocs(project.id, req.signal).then((items) => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))).catch(() => null),
  ]);
  return { project, people, sketches, docs };
}

/**
 * The optional views a project shows (#351, F-026 S21): those added on purpose (a template, More), plus
 * any it already uses: a Map with sketches, a Wiki with docs, Agents with an agent in the project. So an
 * existing project never loses a view it uses, and a new one shows them the first time they are needed.
 */
export function shownViews(shell: ProjectShell, current?: ProjectViewId | null): Set<ProjectViewId> {
  const shown = new Set<ProjectViewId>(shell.project.views);
  if (shell.sketches?.total) shown.add('map');
  if (shell.docs?.length) shown.add('docs');
  if (shell.people?.some((person) => person.kind === 'agent')) shown.add('agents');
  if (current) shown.add(current);
  return shown;
}

/** What More can still add, in the views' own order. */
export const addableViews = (shown: ReadonlySet<ProjectViewId>) => PROJECT_VIEWS.filter((view) => !shown.has(view));

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
 * The project's audience in words, from the people who can read it now: "Only you",
 * "Kai and you · only you two", "Ari, Nia and you", "Ari, Nia, you and 4 others". Agents with
 * access are named as a count so they are never hidden. A project open to its workspace is never
 * "only" anyone's: whoever joins the workspace later can read it too (#188).
 */
export function audienceLine(people: ProjectPerson[] | null, meId: string, open = false): string {
  if (!people) return 'People with project access';
  const others = people.filter((person) => person.kind === 'human' && person.id !== meId).map((person) => firstName(person.name));
  const agents = people.filter((person) => person.kind === 'agent').length;
  const humans = !others.length ? (agents || open ? 'You' : 'Only you')
    : others.length === 1 ? `${others[0]} and you${agents || open ? '' : ' · only you two'}`
      : others.length <= 3 ? join([...others, 'you'])
        : `${others.slice(0, 2).join(', ')}, you and ${others.length - 2} others`;
  return agents ? `${humans} · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : humans;
}

/** "Reply to Kai…", "Reply to Ari and Nia…" for the composer placeholder. */
export function replyTo(people: ProjectPerson[] | null, meId: string): string {
  const others = (people ?? []).filter((person) => person.kind === 'human' && person.id !== meId).map((person) => firstName(person.name));
  if (!others.length || others.length > 3) return 'Reply…';
  return `Reply to ${join(others)}…`;
}

export const ACCESS_LABEL: Record<ProjectPerson['access'], string> = {
  manager: 'Manages the space',
  contributor: 'Can write',
  viewer: 'Can read',
};
