import { useSyncExternalStore } from 'react';
import { useRouteLoaderData } from 'react-router';
import type { ShellData, WorkspaceSummary } from '../app/data';
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

/** The workspaces that wait to be unlocked, for the sidebar, Home, Inbox and Jump to. */
export function useLockedWorkspaces(): WorkspaceSummary[] {
  return useShell()?.lockedWorkspaces ?? [];
}

export const isManagerOf = (space: WorkspaceSummary | undefined) => space?.role === 'owner' || space?.role === 'admin';

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
