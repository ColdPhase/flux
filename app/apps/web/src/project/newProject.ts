import { useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { createProject } from './api';
import { useShellData } from '../app/data';
import { AccountChangedError, assertSignedInAs } from '../app/personalSpace';

/** Who can see a new space until people are added (F-037): the page and the Create window say the same. */
export const NEW_SPACE_AUDIENCE = 'Until you add people, only you and the company’s admins can open it';

/**
 * Making a space (F-037, #874), shared by this page and the Create window's Space tab: a name, in the company. Every space
 * starts with Conversation, Tasks, Map and Wiki; there are no templates and no goal, and its creator is its first admin.
 * One key per intent, so a retry after a lost answer never makes a second space. `create` resolves to the new space, or
 * null after it has said why not.
 */
export function useNewProject() {
  const { me, workspace } = useShellData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revalidator = useRevalidator();
  const intents = useIntentKeys();
  // Set before the first await, so a second submit in the same tick never sends another command.
  const inFlight = useRef(false);
  // Guests only join the spaces they are added to.
  const allowed = !!workspace && workspace.role !== 'guest';
  const ready = (name: string) => !!name.trim() && allowed;
  async function create(name: string): Promise<Project | null> {
    if (!name.trim() || busy || inFlight.current) return null;
    if (!workspace) { setError('You’re not in a company on this Flux yet. Ask an admin for an invite link.'); return null; }
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await assertSignedInAs(me.user.id);
      const intent = `space:${workspace.id}:${name.trim()}`;
      const project = await createProject(workspace.id, name.trim(), intents.keyFor(intent));
      intents.settle(intent);
      revalidator.revalidate();
      return project;
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof AccountChangedError ? cause.message : 'Could not create this space. Try again.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { space: workspace, allowed, audience: NEW_SPACE_AUDIENCE, busy, error, ready, create };
}
