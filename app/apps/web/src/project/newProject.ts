import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { createProject, listWorkspaceMembers } from './api';
import { useShellData } from '../app/data';
import { AccountChangedError, assertSignedInAs } from '../app/personalSpace';

/**
 * Making a space (F-037, #874), shared by the New space window and its phone page: a name, the people and the AI switch, in the company.
 * Every space starts with Conversation, Tasks, Map and Wiki; there are no templates and no goal, and its creator is its first admin.
 * One key per intent (the name, the people and the switch), so a retry after a lost answer never makes a second space and a changed
 * form never replays the first. `create` resolves to the new space, or null after it has said why not.
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
  async function create(name: string, options: { ai: boolean; people: string[] }): Promise<Project | null> {
    if (!name.trim() || busy || inFlight.current) return null;
    if (!workspace) { setError('You’re not in a company on this Flux yet. Ask an admin for an invite link.'); return null; }
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await assertSignedInAs(me.user.id);
      const intent = `space:${workspace.id}:${name.trim()}:${options.ai ? 'ai' : 'no-ai'}:${[...options.people].sort().join(',')}`;
      const project = await createProject(workspace.id, name.trim(), intents.keyFor(intent), { ai: options.ai, people: options.people });
      intents.settle(intent);
      revalidator.revalidate();
      return project;
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof AccountChangedError ? cause.message : 'Could not create this space. Try again.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { space: workspace, allowed, busy, error, ready, create };
}

/**
 * The people of the company a new space can start with (F-037): everyone but the creator, who is its admin, the company's owner
 * included. A guest cannot start spaces, so nothing is read for one.
 */
export function useCompanyCandidates() {
  const { me, workspace } = useShellData();
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const allowed = !!workspace && workspace.role !== 'guest';
  useEffect(() => {
    if (!workspace || !allowed) return undefined;
    const controller = new AbortController();
    listWorkspaceMembers(workspace.id, controller.signal).then(setMembers, () => { if (!controller.signal.aborted) setMembers([]); });
    return () => controller.abort();
  }, [workspace, allowed]);
  const candidates = (members ?? []).filter((member) => member.userId !== me.user.id);
  return { candidates, loading: members === null && allowed, companyName: workspace?.name ?? 'the company' };
}
