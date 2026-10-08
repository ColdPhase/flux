import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { NeedsYouItem, ResolveNeedsYouCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellActions } from '../app/shellContext';
import { useToast } from '../ui';
import { updateWork } from '../work/api';
import { announceInboxChange } from './api';
import type { CardHandlers, SnoozeChoice } from './NeedsYouCard';
import { nextWeek, tomorrowMorning } from './format';
import { flushAccepts, startAccept } from './pendingAccept';
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
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  // The latest queue without re-creating the handlers (and the keys that use them) on every answer.
  const latest = useRef(queue);
  useEffect(() => { latest.current = queue; });
  // Leaving the place sends what is waiting, so nothing the person said is lost.
  useEffect(() => () => flushAccepts(), []);

  /** Stores the choice, shows the toast, and reverses the choice on Undo. */
  const resolve = useCallback((item: NeedsYouItem, command: ResolveNeedsYouCommand, message: string) => {
    latest.current.hide(item.key);
    const stored = resolveNeedsYou(item.key, command).then(announceInboxChange);
    stored.catch((error: unknown) => {
      latest.current.show(item);
      toast({ message: apiMessage(error, 'That did not work. Try again.'), tone: 'danger' });
    });
    toast({ message, action: { label: 'Undo', key: 'Z', onAction: () => {
      latest.current.show(item);
      void stored.then(() => restoreNeedsYou(item.key)).then(announceInboxChange).catch(() => {
        latest.current.reload();
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
      const decision = item.decision;
      if (!decision) return;
      latest.current.hide(item.key);
      const handle = startAccept({ id: decision.id, version: decision.version }, (outcome) => {
        announceInboxChange();
        if (outcome === 'accepted') return;
        latest.current.show(item);
        latest.current.reload();
        toast(outcome === 'conflict'
          ? { message: 'This decision changed before it was accepted. Nothing was accepted. Open it to look again.', tone: 'danger' }
          : { message: 'Could not accept. Nothing changed. Try again.', tone: 'danger' });
      });
      toast({ message: 'Accepted', tone: 'success', action: { label: 'Undo', key: 'Z', onAction: () => {
        if (handle.undo()) { latest.current.show(item); return; }
        // It was already sent (the place was left, or the window ended): a decision is never un-accepted.
        toast({ message: 'It is already accepted. To change direction, propose a new decision.' });
      } } });
    },

    open(item: NeedsYouItem) {
      if (item.kind === 'decision' && item.decision && item.project) openDetails({ kind: 'decision', id: item.decision.id, projectId: item.project.id });
      else if (item.kind === 'blocked' && item.blocked && item.project) openDetails({ kind: 'work', id: item.blocked.workId, projectId: item.project.id });
      else void navigate(item.url);
    },

    discuss(item: NeedsYouItem) {
      void navigate(item.project ? `/projects/${item.project.id}` : item.url);
    },

    unblock(item: NeedsYouItem) {
      const blocked = item.blocked;
      if (!blocked) return;
      // Work that waits for another task starts only when that task is done, so it goes back to Open.
      const status = blocked.waitingFor ? 'open' : 'in_progress';
      latest.current.hide(item.key);
      const changed = updateWork({ id: blocked.workId, version: blocked.version }, { status, blocker: null }, crypto.randomUUID());
      changed.then(announceInboxChange, (error: unknown) => {
        latest.current.show(item);
        toast({ message: apiMessage(error, 'The task could not be unblocked. Open it to look again.'), tone: 'danger' });
      });
      toast({ message: 'Blocker cleared', action: { label: 'Undo', key: 'Z', onAction: () => {
        latest.current.show(item);
        void changed.then((work) => updateWork(work, { status: 'blocked', blocker: blocked.blocker }, crypto.randomUUID())).then(announceInboxChange).catch(() => {
          latest.current.reload();
          toast({ message: 'Undo did not work. Open the task to block it again.', tone: 'danger' });
        });
      } } });
    },
  }), [resolve, toast, navigate, openDetails]);
}
