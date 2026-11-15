import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { NamedPrincipal, ObjectNotice, ObjectRef } from '@flux/contracts';

/**
 * A decision proposed from the Create window reaches everyone at once (founder decision L, #1424, 2026-11-15): there is no hold, and
 * Undo withdraws it for everyone. Its card shows in the proposer's conversation the moment Propose is pressed, "Proposed", as a new
 * task's card does (#1424: expectation is outcome), while its request is on its way: this keeps those pending proposals of this tab,
 * each as the notice the server will write. One that was made keeps its card under its real id until the conversation's own read has
 * it, so the card never blinks out or moves; one that was refused or withdrawn leaves. Opening a pending card opens the decision once
 * it exists.
 */

interface Pending {
  notice: ObjectNotice;
  /** The decision's id once the server made it, or null when it was not made. */
  made: Promise<string | null>;
}

const PENDING = 'pending:';
let pending: readonly Pending[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = (next: readonly Pending[]) => { pending = next; for (const listener of [...listeners]) listener(); };

/** A card of a proposal whose request has not been answered yet: it opens once the decision exists. */
export const isPendingDecision = (decisionId: string) => decisionId.startsWith(PENDING);

export interface PendingProposal {
  /** The card's id while its request is on its way (`decision:<id>` on its button). */
  id: string;
  /** It was made: the card takes the decision's real id. */
  proposed(decisionId: string): void;
  /** Refused or withdrawn: the card leaves. */
  drop(): void;
}

/** Shows a proposal being sent as its card in its space's conversation (and in the thread it came from). */
export function holdProposal(proposal: { projectId: string; workspaceId: string; title: string; by: NamedPrincipal; sources: ObjectRef[]; conversationId: string | null },
  made: Promise<string | null>): PendingProposal {
  const id = `${PENDING}${crypto.randomUUID()}`;
  const entry: Pending = { notice: { ...proposal, id, kind: 'decision.proposed', decisionId: id, status: 'proposed', decided: null, createdAt: new Date().toISOString() }, made };
  changed([...pending, entry]);
  // The entry is known by its `made`: its notice changes when the proposal is made.
  const find = () => pending.findIndex((item) => item.made === entry.made);
  return {
    id,
    proposed(decisionId) {
      const at = find();
      if (at < 0) return;
      // The id the server gives its notice (`<id>:proposed`): when the read brings it, the same card stays in its place.
      const next = { ...pending[at]!, notice: { ...pending[at]!.notice, id: `${decisionId}:proposed`, decisionId } };
      changed(pending.map((item, index) => (index === at ? next : item)));
    },
    drop() { if (find() >= 0) changed(pending.filter((item) => item.made !== entry.made)); },
  };
}

/** Opens a pending card: its decision's id comes back once it exists. */
export function decisionOnceMade(decisionId: string): Promise<string | null> {
  const entry = pending.find((item) => item.notice.decisionId === decisionId);
  return entry ? entry.made : Promise.resolve(null);
}

/**
 * The space's decision notices with this tab's pending proposals among them. A proposal the read already holds is shown from the read,
 * and is forgotten here.
 */
export function useWithHeldProposals(projectId: string, objects: ObjectNotice[]): ObjectNotice[] {
  const all = useSyncExternalStore(subscribe, () => pending, () => pending);
  const read = useMemo(() => new Set(objects.map((notice) => notice.decisionId)), [objects]);
  useEffect(() => {
    if (all.some((item) => read.has(item.notice.decisionId))) changed(pending.filter((item) => !read.has(item.notice.decisionId)));
  }, [all, read]);
  return useMemo(() => {
    const mine = all.filter((item) => item.notice.projectId === projectId && !read.has(item.notice.decisionId)).map((item) => item.notice);
    return mine.length ? [...objects, ...mine] : objects;
  }, [all, objects, read, projectId]);
}
