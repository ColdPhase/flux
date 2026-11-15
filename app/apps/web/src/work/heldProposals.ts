import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { NamedPrincipal, ObjectNotice, ObjectRef } from '@flux/contracts';

/**
 * A decision proposed with Undo (#763 WF-3) is sent when its toast leaves, about 10 s later, and until then the server has nothing to
 * show. Its card shows in the proposer's conversation at once all the same, "Proposed", as a new task's card does (#1424: expectation is
 * outcome): this keeps the proposals held in this tab, each as the notice the server will write. Undo takes the card away, and so does a
 * proposal that was not made. One that was sent keeps its card under its real id until the conversation's own read has it, so the card
 * never blinks out or moves. Opening a held card sends the proposal at once and opens the decision when it exists.
 */

interface Held {
  notice: ObjectNotice;
  /** Sends the proposal now (its Undo window ends) and answers the decision's id, or null when it was not made. */
  send: () => Promise<string | null>;
}

const HELD = 'held:';
let held: readonly Held[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = (next: readonly Held[]) => { held = next; for (const listener of [...listeners]) listener(); };

/** A card of a proposal still held for Undo: it opens by sending it. */
export const isHeldDecision = (decisionId: string) => decisionId.startsWith(HELD);

export interface HeldProposal {
  /** It was made: the card takes the decision's real id. */
  proposed(decisionId: string): void;
  /** Undone or refused: the card leaves. */
  drop(): void;
}

/** Shows a proposal held for Undo as its card in its space's conversation (and in the thread it came from). */
export function holdProposal(proposal: { projectId: string; workspaceId: string; title: string; by: NamedPrincipal; sources: ObjectRef[]; conversationId: string | null },
  send: () => Promise<string | null>): HeldProposal {
  const id = `${HELD}${crypto.randomUUID()}`;
  const entry: Held = { notice: { ...proposal, id, kind: 'decision.proposed', decisionId: id, status: 'proposed', createdAt: new Date().toISOString() }, send };
  changed([...held, entry]);
  // The entry is known by its `send`: its notice changes when the proposal is made.
  const find = () => held.findIndex((item) => item.send === entry.send);
  return {
    proposed(decisionId) {
      const at = find();
      if (at < 0) return;
      // The id the server gives its notice (`<id>:proposed`): when the read brings it, the same card stays in its place.
      const next = { ...held[at]!, notice: { ...held[at]!.notice, id: `${decisionId}:proposed`, decisionId } };
      changed(held.map((item, index) => (index === at ? next : item)));
    },
    drop() { if (find() >= 0) changed(held.filter((item) => item.send !== entry.send)); },
  };
}

/** Opens a held card: the proposal is sent now, and its decision's id comes back once it exists. */
export function sendHeldProposal(decisionId: string): Promise<string | null> {
  const entry = held.find((item) => item.notice.decisionId === decisionId);
  return entry ? entry.send() : Promise.resolve(null);
}

/**
 * The space's decision notices with this tab's held proposals among them. A proposal the read already holds is shown from the read, and
 * is forgotten here.
 */
export function useWithHeldProposals(projectId: string, objects: ObjectNotice[]): ObjectNotice[] {
  const all = useSyncExternalStore(subscribe, () => held, () => held);
  const read = useMemo(() => new Set(objects.filter((notice) => notice.kind === 'decision.proposed').map((notice) => notice.decisionId)), [objects]);
  useEffect(() => {
    if (all.some((item) => read.has(item.notice.decisionId))) changed(held.filter((item) => !read.has(item.notice.decisionId)));
  }, [all, read]);
  return useMemo(() => {
    const mine = all.filter((item) => item.notice.projectId === projectId && !read.has(item.notice.decisionId)).map((item) => item.notice);
    return mine.length ? [...objects, ...mine] : objects;
  }, [all, objects, read, projectId]);
}
