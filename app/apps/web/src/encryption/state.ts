import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouteLoaderData } from 'react-router';
import type { ProjectPerson } from '@flux/contracts';
import type { ShellData, WorkspaceSummary } from '../app/data';
import { listMembers } from '../people/api';
import type { WorkspaceEncryption } from './api';

// What the shell knows about encrypted workspaces (F-030, #655). The shell loader reads every workspace, including
// the locked ones (their name, people and roles are metadata); a locked workspace is kept out of `workspaces` and
// listed in `lockedWorkspaces`, so nothing that fetches content for each workspace asks a locked one.

function useShell(): ShellData | undefined {
  return useRouteLoaderData('app') as ShellData | undefined;
}

/** One workspace of the person, locked or not. */
export function useSpace(workspaceId: string | null | undefined): WorkspaceSummary | undefined {
  const shell = useShell();
  return shell ? [...shell.workspaces, ...shell.lockedWorkspaces].find((space) => space.id === workspaceId) : undefined;
}

/** The workspace's encryption state; null for a plain workspace and for one the shell does not list. */
export function useWorkspaceEncryption(workspaceId: string | null | undefined): WorkspaceEncryption | null {
  return useSpace(workspaceId)?.encryption ?? null;
}

/**
 * The encrypted workspaces of the person, locked or not: a space whose workspace is one of them is an encrypted space, and it has a
 * small lock after its name in the sidebar, the phone's Spaces and its header (F-026 §4).
 */
export function useEncryptedWorkspaceIds(): ReadonlySet<string> {
  const shell = useShell();
  return useMemo(() => new Set([...(shell?.workspaces ?? []), ...(shell?.lockedWorkspaces ?? [])]
    .filter((space) => space.encryption).map((space) => space.id)), [shell?.workspaces, shell?.lockedWorkspaces]);
}

/** The workspaces that wait to be unlocked, for the sidebar, Home, Inbox and Search. */
export function useLockedWorkspaces(): WorkspaceSummary[] {
  return useShell()?.lockedWorkspaces ?? [];
}

export const isManagerOf = (space: WorkspaceSummary | undefined) => space?.role === 'owner' || space?.role === 'admin';

/**
 * What a locked space says of itself in a list (C-24): an admin who can unlock it is told so; everyone else waits for an admin, after
 * every restart of the server, until one enters their unlock password.
 */
export const lockedLine = (space: WorkspaceSummary | undefined) => space?.encryption?.canUnlock ? 'Locked, unlock it' : 'Locked, waiting for an admin';

// The page in view is a place of a locked workspace (a deep link, or a tab that was open when it locked). The route's error
// boundary says so, and the shell's header reads it, so the header names the space instead of the Home it fell back to.
let lockedPlace: string | null = null;
const listeners = new Set<() => void>();
export function setLockedPlace(workspaceId: string | null) {
  if (lockedPlace === workspaceId) return;
  lockedPlace = workspaceId;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLockedPlace(): string | null {
  return useSyncExternalStore(subscribe, () => lockedPlace, () => null);
}

/**
 * The people of a locked space, for the faces in its header (F-026 §7 Spaces: a locked space keeps its header). Who is in a space and with
 * which role is metadata, readable while it is locked (encryption.ts); only what is inside is sealed. Null until they are read, and when
 * they cannot be: the header then draws no faces and nothing else changes.
 */
export function useLockedPeople(workspaceId: string | null): ProjectPerson[] | null {
  const [read, setRead] = useState<{ workspaceId: string; people: ProjectPerson[] } | null>(null);
  useEffect(() => {
    if (!workspaceId) return undefined;
    const controller = new AbortController();
    listMembers(workspaceId, controller.signal).then((members) => {
      setRead({ workspaceId, people: members.map((member) => ({
        kind: 'human' as const, id: member.userId, name: member.name, access: member.role === 'owner' || member.role === 'admin' ? 'manager' as const : 'contributor' as const,
        ...(member.lastActiveAt ? { lastActiveAt: member.lastActiveAt } : {}),
      })) });
    }, () => undefined);
    return () => controller.abort();
  }, [workspaceId]);
  return read && read.workspaceId === workspaceId ? read.people : null;
}
