import { useCallback, useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Conversation, Project, ProjectPerson } from '@flux/contracts';
import { ApiError } from '../api/client';
import type { MeResponse } from '../api/auth';
import { useShellData } from '../app/data';
import { useSpaceAi } from '../ai/spaceAi';
import { audienceLine, useProjectShell } from '../project/data';
import { getProject } from '../project/api';
import type { ProjectData } from './loader';

/** What every part of one conversation pane (the stream's or a thread's) reads: who, where, and what they may do. */
export interface PaneCore {
  me: MeResponse; project: Project; conversation: Conversation | null; people: ProjectPerson[] | null;
  /** The pane's own field: the stream's composer, or the open thread's reply field. */
  composerId: string;
  writable: boolean;
  /**
   * A company owner or admin who can open this space without being in it (C-15): their assistant works only in spaces they are in,
   * so the ask bar says so and offers Add me.
   */
  outside: boolean;
  /** AG-10: while the space's AI is off this conversation is human-only: no assistant, no AI commands, no suggestions. */
  aiOff: boolean;
  /** "Only you and Kai", and the same without "only you two" for the assistant's line. */
  audience: string; audienceShort: string;
  /**
   * The stream and the thread are two panes on one route: the stream's revalidation changes the router's
   * state every 15 s. Read the latest revalidate through a ref, so this pane's own refresh (and its 15 s
   * fallback timer) keeps its identity and is not restarted, and so never starved, by the other pane.
   */
  revalidateRef: { current: () => unknown };
}

export function usePaneCore(data: ProjectData, variant: 'stream' | 'thread'): PaneCore {
  const { project } = data;
  const conversation = variant === 'thread' ? data.conversation : null;
  const people = useProjectShell()?.people ?? null;
  const { me, reachableSpaces } = useShellData();
  const revalidator = useRevalidator();
  const revalidateRef = useRef<() => unknown>(revalidator.revalidate);
  useEffect(() => { revalidateRef.current = revalidator.revalidate; });
  const aiOff = useSpaceAi(project.id).blocked;
  const outside = reachableSpaces.find((space) => space.id === project.id)?.member === false;
  const audience = audienceLine(people, me.user.id, project.visibility === 'workspace');
  return {
    me, project, conversation, people, composerId: conversation ? 'thread-composer' : 'project-composer', writable: true, aiOff, outside,
    audience, audienceShort: audience.replace(/ · only you two$/, ''), revalidateRef,
  };
}

/**
 * A refused read: a 403 reloads the route (the person may only read now); a 401 or 404 hides the pane's
 * content at once and reloads the route, which leads to the nearest place the person can open (#592).
 */
export function usePaneAccess({ project, revalidateRef }: PaneCore) {
  const [accessLost, setAccessLost] = useState(false);
  const hideIfDenied = useCallback((cause: unknown) => {
    if (!(cause instanceof ApiError)) return;
    if (cause.status === 403) { revalidateRef.current(); return; }
    if (cause.status !== 401 && cause.status !== 404) return;
    setAccessLost(true);
    revalidateRef.current();
    void getProject(project.id).then(() => setAccessLost(false)).catch(() => { /* denial keeps previous content hidden */ });
  }, [project.id, revalidateRef]);
  return { accessLost, hideIfDenied };
}
