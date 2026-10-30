import { useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project, ProjectTemplate } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { createProject, createWorkspace } from '../app/conversation-api';
import { useShellData } from '../app/data';

/** What a project can start from (F-026 S20). Conversation is always there; the second line says what else. */
export const TEMPLATES: { id: ProjectTemplate; name: string; has: string }[] = [
  { id: 'build', name: 'Build something', has: 'Conversation + Tasks' },
  { id: 'research', name: 'Research', has: 'Conversation + Wiki' },
  { id: 'event', name: 'Plan an event', has: 'Conversation + Tasks' },
  { id: 'blank', name: 'Blank', has: 'Conversation only' },
];

/** Who can see a new project (restricted, #188) until people are invited: the page and the Create window say the same. */
export const NEW_PROJECT_AUDIENCE = 'You and the workspace’s owners and admins can see it until you invite someone';

/**
 * Making a project (S20), shared by this page and the Create window's Project tab: the person's space (named here when
 * they have none yet), a template, and one key per intent, so a retry after a lost answer never makes a second space or
 * project. `create` resolves to the new project, or null after it has said why it could not.
 */
export function useNewProject() {
  const { workspace } = useShellData();
  const [spaceName, setSpaceName] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('build');
  const [createdSpace, setCreatedSpace] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revalidator = useRevalidator();
  const intents = useIntentKeys();
  // Set before the first await, so a second submit in the same tick never sends another command.
  const inFlight = useRef(false);
  const space = workspace ?? createdSpace;
  const ready = (name: string) => !!name.trim() && (!!space || !!spaceName.trim());
  async function create(name: string): Promise<Project | null> {
    if (!ready(name) || busy || inFlight.current) return null;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      const spaceIntent = `workspace:${spaceName.trim()}`;
      const target = space ?? await createWorkspace(spaceName.trim(), intents.keyFor(spaceIntent));
      if (!space) { setCreatedSpace(target); intents.settle(spaceIntent); }
      const projectIntent = `project:${target.id}:${name.trim()}:${template}`;
      const project = await createProject(target.id, name.trim(), template, intents.keyFor(projectIntent));
      intents.settle(projectIntent);
      revalidator.revalidate();
      return project;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not create this project. Try again.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { space, spaceName, setSpaceName: (value: string) => { setSpaceName(value); setError(''); }, template, setTemplate, busy, error, ready, create };
}
