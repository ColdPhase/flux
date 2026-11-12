import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SPACE_ORDER_PATH, orderSpaces, type SetSpaceOrderCommand, type SpaceOrder } from '@flux/contracts';
import { request } from '../api/client';
import { everyoneIn, useShellData, type ProjectSummary } from './data';
import { useToast } from '../ui';

/**
 * The person's own order of their spaces (#1250). The server keeps it per person, so it is the same on every device and in every tab; the
 * shell reads it with the spaces and lists them in it (`readShell`). What the person has just moved shows at once, from `local`, while
 * the server saves it; the shell's next read replaces it with the server's answer: the save's own live event (every open tab of the person
 * gets it, this one too) asks for that read. A change made in another tab only ever arrives as that read: it is never animated here.
 */
export const saveSpaceOrder = (order: string[]) =>
  request<SpaceOrder>(SPACE_ORDER_PATH, { method: 'PUT', body: { order } satisfies SetSpaceOrderCommand, leavesReads: true });

interface Local { owner: string; order: readonly string[] }
let local: Local | null = null;
/** Saves in flight: the shell's answers that arrive meanwhile may still be from before them. */
let writing = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function setLocal(next: Local | null) {
  local = next;
  for (const listener of [...listeners]) listener();
}

/** The person's spaces in their order, with what they moved a moment ago in place of what the shell last read. */
export function useOrderedProjects(): ProjectSummary[] {
  const shell = useShellData();
  const now = useSyncExternalStore(subscribe, () => local, () => null);
  // A new answer from the shell is the server's order: what was moved is in it, or another tab moved something later.
  useEffect(() => { if (!writing && local) setLocal(null); }, [shell.spaceOrder]);
  return useMemo(() => {
    const everyone = everyoneIn(shell.workspaces);
    return now && now.owner === shell.me.user.id ? orderSpaces(shell.projects, now.order, everyone) : shell.projects;
  }, [now, shell.projects, shell.workspaces, shell.me.user.id]);
}

/**
 * What the person says when they move a space (a drag, a long press or ⋯ › Move up / Move down): `moveTo` puts the space at a place of
 * the list (counted from 0, Everyone included), `status` is the sentence a polite live region says ("Release check, moved to position 3
 * of 8"). Everyone cannot be moved, and nothing can be put before it.
 */
export function useSpaceMoves(projects: readonly ProjectSummary[]) {
  const shell = useShellData();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const now = useRef({ projects, shell });
  useEffect(() => { now.current = { projects, shell }; });
  const fixed = useMemo(() => projects.filter(everyoneIn(shell.workspaces)).length, [projects, shell.workspaces]);

  const moveTo = useCallback((id: string, to: number): boolean => {
    const { projects: list, shell: data } = now.current;
    const same = everyoneIn(data.workspaces);
    const lead = list.filter(same).length;
    const ids = list.map((project) => project.id);
    const from = ids.indexOf(id);
    const place = Math.max(lead, Math.min(ids.length - 1, to));
    if (from < lead || from === place) return false;
    ids.splice(from, 1);
    ids.splice(place, 0, id);
    const order = ids.filter((one) => !list.some((project) => project.id === one && same(project)));
    setLocal({ owner: data.me.user.id, order });
    const name = list[from]!.name;
    setStatus(`${name}, moved to position ${place + 1} of ${ids.length}`);
    writing += 1;
    saveSpaceOrder(order).then(() => undefined, () => {
      // Not saved: the list is the server's again.
      toast({ message: 'Couldn’t save the order. It is back as it was.', tone: 'danger' });
      setLocal(null);
    }).finally(() => { writing -= 1; });
    return true;
  }, [toast]);

  return { moveTo, status, fixed };
}

/**
 * A space row's name for assistive technology: its name, then what the row shows besides it (the lock, the muted mark, what is new, the
 * dot that says an Inbox item waits there). Undefined when the row shows nothing but its name. A muted space's count takes the dot's place,
 * as it does on screen (#1249, #1250).
 */
export function spaceRowLabel(name: string, row: { encrypted: boolean; quiet: boolean; fresh: number; needsYou: boolean }): string | undefined {
  const needsYou = row.needsYou && !(row.fresh && row.quiet);
  if (!row.encrypted && !row.quiet && !row.fresh && !needsYou) return undefined;
  return `${name}${row.encrypted ? ', encrypted' : ''}${row.quiet ? ', muted' : ''}${row.fresh ? (row.quiet ? `, ${row.fresh} new` : ', new activity') : ''}${needsYou ? ', needs you' : ''}`;
}
