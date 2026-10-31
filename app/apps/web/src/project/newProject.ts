import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project, ProjectTemplate } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { createProject, listWorkspaceMembers } from './api';
import { useShellData, type WorkspaceSummary } from '../app/data';
import { AccountChangedError, assertSignedInAs, ensureOwnSpace, ownSpaceName } from '../app/personalSpace';

/** What a project can start from (F-026 S20). Conversation is always there; the second line says what else. */
export const TEMPLATES: { id: ProjectTemplate; name: string; has: string }[] = [
  { id: 'build', name: 'Build something', has: 'Conversation + Tasks' },
  { id: 'research', name: 'Research', has: 'Conversation + Wiki' },
  { id: 'event', name: 'Plan an event', has: 'Conversation + Tasks' },
  { id: 'blank', name: 'Blank', has: 'Conversation only' },
];

/** Who can see a new project (restricted, #188) until people are invited: the page and the Create window say the same. */
export const NEW_PROJECT_AUDIENCE = 'You and the workspace’s owners and admins can see it until you invite someone';
/** The drawn sentence (S20) when the creator is the workspace's only owner or admin, or the workspace is made with it (#763 FR-5). */
export const NEW_PROJECT_ONLY_YOU = 'Only you can see it until you invite someone';

/** Only owners and admins create projects in a workspace (the `project.create` rule). */
const canCreateIn = (space: WorkspaceSummary) => space.role === 'owner' || space.role === 'admin';

/**
 * Making a project (S20), shared by this page and the Create window's Project tab: a name, a template and where it goes.
 * Nobody names a workspace first (#763 FR-1): with no workspace of their own, the person's own one is made with the
 * project, quietly ("Maria’s space"). With two or more where they may create projects, `places` lists them for an
 * "In … ▾" picker (#763 PE-3); otherwise the one place is only named. One key per intent, so a retry after a lost answer
 * never makes a second workspace or project. `create` resolves to the new project, or null after it has said why not.
 */
export function useNewProject() {
  const { me, workspaces, projects } = useShellData();
  const places = workspaces.filter(canCreateIn);
  const [template, setTemplate] = useState<ProjectTemplate>('build');
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revalidator = useRevalidator();
  const intents = useIntentKeys();
  // Set before the first await, so a second submit in the same tick never sends another command.
  const inFlight = useRef(false);
  // The current project's workspace first, when the person may create projects there; then the first such workspace.
  const here = typeof window === 'undefined' ? undefined : window.location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const hereSpace = projects.find((project) => project.id === here)?.workspaceId;
  const space = places.find((item) => item.id === chosen) ?? places.find((item) => item.id === hereSpace) ?? places[0] ?? null;
  const spaceId = space?.id;
  const spaceName = space?.name ?? ownSpaceName(me.user.name);
  // Who else can see it until people are invited: the drawn "Only you" when nobody else manages this workspace.
  const [othersManage, setOthersManage] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!spaceId || spaceId in othersManage) return undefined;
    const controller = new AbortController();
    listWorkspaceMembers(spaceId, controller.signal).then((members) => {
      const others = members.some((member) => member.userId !== me.user.id && (member.role === 'owner' || member.role === 'admin'));
      setOthersManage((known) => ({ ...known, [spaceId]: others }));
    }, () => undefined);
    return () => controller.abort();
  }, [spaceId, othersManage, me.user.id]);
  const audience = !space || othersManage[space.id] === false ? NEW_PROJECT_ONLY_YOU : NEW_PROJECT_AUDIENCE;
  const ready = (name: string) => !!name.trim();
  async function create(name: string): Promise<Project | null> {
    if (!ready(name) || busy || inFlight.current) return null;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await assertSignedInAs(me.user.id);
      const target = space?.id ?? await ensureOwnSpace(me.user);
      const projectIntent = `project:${target}:${name.trim()}:${template}`;
      const project = await createProject(target, name.trim(), template, intents.keyFor(projectIntent));
      intents.settle(projectIntent);
      revalidator.revalidate();
      return project;
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof AccountChangedError ? cause.message : 'Could not create this project. Try again.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { space, spaceName, places, choose: (id: string) => { setChosen(id); setError(''); }, audience, template, setTemplate, busy, error, ready, create };
}
