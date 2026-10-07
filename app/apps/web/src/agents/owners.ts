import { useEffect, useRef, useState } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import type { Project } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useStreamEvents } from '../api/stream';
import { listProjectPeople } from '../project/data';

/** Agent owners from this project's current authorized audience; no workspace roster or shared cache. */
export type AgentOwners = ReadonlyMap<string, string>;
const EMPTY: AgentOwners = new Map();

export function useAgentOwners(project: Pick<Project, 'id' | 'workspaceId'> | null | undefined): AgentOwners {
  const { me } = useShellData();
  const { key: visit } = useLocation();
  const revalidator = useRevalidator();
  const scope = project ? `${me.user.id}:${project.workspaceId}:${project.id}:${visit}` : null;
  const [read, setRead] = useState<{ scope: string; owners: AgentOwners } | null>(null);
  const [boundary, setBoundary] = useState({ scope, phase: revalidator.state });
  if (boundary.scope !== scope || boundary.phase !== revalidator.state) {
    setBoundary({ scope, phase: revalidator.state });
    if (read) setRead(null);
  }
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!scope || !project || revalidator.state !== 'idle') return;
    let current: AbortController | null = null;
    const load = () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      // An access change or failed read never leaves an obsolete owner name visible.
      setRead(null);
      void listProjectPeople(project.id, controller.signal).then((people) => {
        if (controller.signal.aborted) return;
        const owners = new Map(people.flatMap((person) => {
          if (person.kind !== 'agent' || !person.agentOwner) return [];
          return [[person.id, person.agentOwner.kind === 'workspace' ? 'the workspace' : person.agentOwner.name] as const];
        }));
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
  }, [scope, project?.id, revalidator.state]);
  useStreamEvents(me.user.id, (event) => {
    if (event.workspaceId === project?.workspaceId) reload.current();
  }, () => reload.current());
  return boundary.scope === scope && boundary.phase === revalidator.state && revalidator.state === 'idle' && read?.scope === scope ? read.owners : EMPTY;
}
