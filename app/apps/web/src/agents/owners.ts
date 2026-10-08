import { useEffect, useRef, useState } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import type { ConversationMessage, Project } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { listProjectPeople } from '../project/data';

/** Agent owners from this project's current authorized audience; no workspace roster or shared cache. */
export type AgentOwners = ReadonlyMap<string, string>;
const EMPTY: AgentOwners = new Map();

/** A historical author may lose its grant; its owner name still needs a fresh authorized audience. */
export function agentAuthorOwner(author: Extract<ConversationMessage, { authorId: null }>['author'], owners: AgentOwners): string | undefined {
  const current = owners.get(author.id);
  if (current) return current;
  const projected = author.projectOwner;
  if (projected?.kind === 'workspace') return owners.get('owner:workspace');
  return projected?.kind === 'human' ? owners.get(`human:${projected.id}`) : undefined;
}

export function useAgentOwners(project: Pick<Project, 'id' | 'workspaceId'> | null | undefined): AgentOwners {
  const { me } = useShellData();
  const { key: visit } = useLocation();
  const revalidator = useRevalidator();
  const projectId = project?.id;
  const scope = project ? `${me.user.id}:${project.workspaceId}:${project.id}:${visit}` : null;
  const [read, setRead] = useState<{ scope: string; owners: AgentOwners } | null>(null);
  const [boundary, setBoundary] = useState({ scope, phase: revalidator.state });
  if (boundary.scope !== scope || boundary.phase !== revalidator.state) {
    setBoundary({ scope, phase: revalidator.state });
    if (read) setRead(null);
  }
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!scope || !projectId || revalidator.state !== 'idle') return;
    let current: AbortController | null = null;
    const load = () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      // An access change or failed read never leaves an obsolete owner name visible.
      setRead(null);
      void listProjectPeople(projectId, controller.signal).then((people) => {
        if (controller.signal.aborted) return;
        const owners = new Map<string, string>([['owner:workspace', 'the workspace'], ...people.flatMap((person) => {
          if (person.kind === 'human') return [[`human:${person.id}`, person.name] as const];
          if (person.kind !== 'agent' || !person.agentOwner) return [];
          return [[person.id, person.agentOwner.kind === 'workspace' ? 'the workspace' : person.agentOwner.name] as const];
        })]);
        setRead({ scope, owners });
      }, () => { if (!controller.signal.aborted) setRead(null); });
    };
    reload.current = load;
    load();
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    return () => {
      current?.abort();
      reload.current = () => undefined;
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
    };
  }, [scope, projectId, revalidator.state]);
  useStreamEvents(me.user.id, (event) => {
    if (event.workspaceId === project?.workspaceId) reload.current();
  }, () => reload.current());
  return boundary.scope === scope && boundary.phase === revalidator.state && revalidator.state === 'idle' && read?.scope === scope ? read.owners : EMPTY;
}
