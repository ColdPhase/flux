import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFollow } from '../place/origin';
import type { NeedsYouItem, ResolveNeedsYouCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellActions } from '../app/shellContext';
import { useToast } from '../ui';
import { updateWork } from '../work/api';
import { applyRunChanges } from '../assistant/api';
import { announceAcceptedInboxItem, announceInboxChange } from './api';
import type { CardHandlers, SnoozeChoice } from './NeedsYouCard';
import { nextWeek, tomorrowMorning } from './format';
import { ACCEPT_UNDO_MS, flushAccepts, startAccept } from './pendingAccept';
import { restoreNeedsYou, resolveNeedsYou, type Queue } from './needsYou';

const apiMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

/**
 * What a person does with an item of the queue, shared by the Inbox and Home (#342, F-026 S9/S11).
 * Done, Not now, Decline and Unblock apply at once and offer Undo (`Z`) as a real reversal. A decision
 * cannot be un-accepted, so Accept is a delayed command: the item leaves at once and is sent when the
 * Undo window ends, or when the person leaves this place (see `pendingAccept`).
 */
export function useNeedsYouActions(queue: Queue): CardHandlers {
  const toast = useToast();
  // An item opens its source as a reference: the Inbox is where Back returns to (#592).
  const navigate = useFollow();
  const { openDetails } = useShellActions();
  // The latest queue without re-creating the handlers (and the keys that use them) on every answer.
  const latest = useRef(queue);
  useEffect(() => { latest.current = queue; });
  // Leaving the place sends what is waiting, so nothing the person said is lost.
  useEffect(() => () => flushAccepts(), []);

  /** Stores the choice, shows the toast, and reverses the choice on Undo. */
  const resolve = useCallback((item: NeedsYouItem, command: ResolveNeedsYouCommand, message: string) => {
    const current = latest.current;
    const stored = resolveNeedsYou(item.key, command).then(announceInboxChange);
    const intent = current.hide(item.key, stored);
    stored.catch((error: unknown) => {
      if (!intent.isCurrent()) return;
      current.show(item);
      toast({ message: apiMessage(error, 'That did not work. Try again.'), tone: 'danger' });
    });
    toast({ message, action: { label: 'Undo', key: 'Z', onClick: () => {
      // Undo may come while the choice is still on its way: the DELETE follows it, and the item is pending until then.
      const restored = stored.then(() => restoreNeedsYou(item.key)).then(announceInboxChange);
      const undoIntent = current.show(item, restored);
      restored.catch(() => {
        if (!undoIntent.isCurrent()) return;
        current.reload();
        toast({ message: 'Undo did not work. The item is back after a refresh.', tone: 'danger' });
      });
    } } });
  }, [toast]);

  return useMemo<CardHandlers>(() => ({
    done: (item) => resolve(item, { action: 'done' }, 'Marked done'),

    snooze(item: NeedsYouItem, choice: SnoozeChoice) {
      if (choice === 'decline') { resolve(item, { action: 'decline' }, 'Declined for good. Only your Inbox changed'); return; }
      if (choice === 'task' && item.snoozeTask) { resolve(item, { action: 'snooze', untilWorkId: item.snoozeTask.id }, `Not now. Back when #${item.snoozeTask.number} is done`); return; }
      const week = choice === 'week';
      resolve(item, { action: 'snooze', until: (week ? nextWeek() : tomorrowMorning()).toISOString() }, week ? 'Not now. Back next week' : 'Not now. Back tomorrow morning');
    },

    accept(item: NeedsYouItem) {
      const current = latest.current;
      const decision = item.decision;
      if (!decision) return;
      // Not pending while the window is open: every read already hides a decision being accepted (acceptingIds).
      const handle = startAccept({ id: decision.id, version: decision.version }, (outcome) => {
        // acceptingIds is cleared before this callback; remove the cached item before any fresh read lands.
        if (outcome === 'accepted') announceAcceptedInboxItem(current.userId, item.key);
        announceInboxChange();
        if (outcome === 'accepted') return;
        current.show(item);
        current.reload();
        toast(outcome === 'conflict'
          ? { message: 'This decision changed before it was accepted. Nothing was accepted. Open it to look again.', tone: 'danger' }
          : { message: 'Could not accept. Nothing changed. Try again.', tone: 'danger' });
      });
      current.hide(item.key);
      // Undo is offered for ACCEPT_UNDO_MS only: the toast closes with the window, so it never outlives it.
      toast({ message: 'Accepted', tone: 'success', timeout: ACCEPT_UNDO_MS, action: { label: 'Undo', key: 'Z', onClick: () => {
        if (handle.undo()) { current.show(item); return; }
        // It was already sent (the place was left, or the window ended): a decision is never un-accepted.
        toast({ message: 'It is already accepted. To change direction, propose a new decision.' });
      } } });
    },

    open(item: NeedsYouItem) {
      if (item.kind === 'decision' && item.decision && item.project) openDetails({ kind: 'decision', id: item.decision.id, projectId: item.project.id });
      else if (item.kind === 'blocked' && item.blocked && item.project) openDetails({ kind: 'work', id: item.blocked.workId, projectId: item.project.id });
      else void navigate(item.assistantRequestIdentity && item.project ? `/inbox/${encodeURIComponent(item.key.replace(/^note:/, ""))}` : item.url);
    },

    applyChanges(item: NeedsYouItem) {
      const current = latest.current;
      const changes = item.assistantChanges;
      if (!changes) return;
      // Each change is applied with every check again; one that changed since says so and applies nothing.
      const applied = applyRunChanges(changes.runId);
      const intent = current.hide(item.key, applied);
      applied.then((result) => {
        announceInboxChange();
        const problems = [...new Set(result.changes.map((entry) => entry.message).filter((message): message is string => !!message))];
        toast(problems.length ? { message: problems.join(' · '), tone: 'danger' } : { message: `Done: ${changes.summary}`, tone: 'success' });
      }, (error: unknown) => {
        if (!intent.isCurrent()) return;
        current.show(item);
        toast({ message: apiMessage(error, 'That did not work. Try again.'), tone: 'danger' });
      });
    },

    discuss(item: NeedsYouItem) {
      void navigate(item.project ? `/projects/${item.project.id}` : item.url);
    },

    unblock(item: NeedsYouItem) {
      const current = latest.current;
      const blocked = item.blocked;
      if (!blocked) return;
      // Work that waits for another task starts only when that task is done, so it goes back to Open.
      const status = blocked.waitingFor ? 'open' : 'in_progress';
      const changed = updateWork({ id: blocked.workId, version: blocked.version }, { status, blocker: null }, crypto.randomUUID());
      const intent = current.hide(item.key, changed);
      changed.then(announceInboxChange, (error: unknown) => {
        if (!intent.isCurrent()) return;
        current.show(item);
        toast({ message: apiMessage(error, 'The task could not be unblocked. Open it to look again.'), tone: 'danger' });
      });
      toast({ message: 'Blocker cleared', action: { label: 'Undo', key: 'Z', onClick: () => {
        const restored = changed.then((work) => updateWork(work, { status: 'blocked', ...(blocked.blocker ? { blocker: blocked.blocker } : {}), ...(blocked.waitingForUserId ? { waitingFor: { kind: 'human' as const, id: blocked.waitingForUserId } } : {}), restore: true }, crypto.randomUUID())).then(announceInboxChange);
        const undoIntent = current.show(item, restored);
        restored.catch(() => {
          if (!undoIntent.isCurrent()) return;
          current.reload();
          toast({ message: 'Undo did not work. Open the task to block it again.', tone: 'danger' });
        });
      } } });
    },
  }), [resolve, toast, navigate, openDetails]);
}
