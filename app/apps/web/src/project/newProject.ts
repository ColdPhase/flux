import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project, WorkspaceMember } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { createEncryptedSpace, encryptionProblem } from '../encryption/api';
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
  // One id per form (and per name): a retry after a lost answer finds the space the first try made, instead of making a second.
  const creation = useRef({ id: crypto.randomUUID(), name: '' });
  /**
   * An encrypted space (F-030, F-037, C-24): the unlock password, the people and the recovery code the person has downloaded go to the
   * server once and are not kept. Resolves to the space (the one project the encrypted workspace holds), or null after saying why not.
   */
  async function createEncrypted(name: string, options: { people: string[]; password: string; recoveryCode: string }): Promise<Project | null> {
    const spaceName = name.trim();
    if (!spaceName || busy || inFlight.current) return null;
    if (!workspace) { setError('You’re not in a company on this Flux yet. Ask an admin for an invite link.'); return null; }
    if (creation.current.name !== spaceName) creation.current = { id: crypto.randomUUID(), name: spaceName };
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await assertSignedInAs(me.user.id);
      const made = await createEncryptedSpace({ name: spaceName, creationId: creation.current.id, password: options.password, companyId: workspace.id,
        people: options.people, recoveryCode: options.recoveryCode });
      creation.current = { id: crypto.randomUUID(), name: '' };
      revalidator.revalidate();
      return made.project;
    } catch (cause) {
      // A refusal means nothing was made, so the next try is a new creation. A lost answer may have made it: the same id finds it.
      if (cause instanceof ApiError && cause.status < 500) creation.current = { id: crypto.randomUUID(), name: '' };
      setError(cause instanceof AccountChangedError ? cause.message
        : cause instanceof NetworkError ? 'Flux couldn’t be reached to finish this space. Try again: if it was made, you’ll go straight to it.'
          : cause instanceof ApiError && cause.code === 'NOT_A_MEMBER' ? 'Someone you chose is no longer in the company. Choose again.'
            : cause instanceof ApiError && cause.code === 'ENCRYPTED_SPACE_COMPANY_ONLY' ? 'Only people in the company who are not guests can make an encrypted space.'
              : encryptionProblem(cause, { workspace: spaceName }));
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { space: workspace, allowed, busy, error, ready, create, createEncrypted };
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
