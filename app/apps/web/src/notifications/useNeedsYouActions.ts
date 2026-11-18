import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFollow } from '../place/origin';
import { awaitField } from '../ui/keys';
import { decisionAppPath, type NeedsYouItem, type ResolveNeedsYouCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { MEDIA, useToast, type ToastOptions } from '../ui';
import { updateWork } from '../work/api';
import { stateWords } from '../work/taskState';
import { useDiscussDecision } from '../work/discuss';
import { applyRunChanges } from '../assistant/api';
import { announceAcceptedInboxItem, announceInboxChange } from './api';
import { itemKeys, type CardHandlers, type SnoozeChoice } from './NeedsYouCard';
import { inboxActed, inboxSettled, inboxSettling } from './settle';
import { tomorrowMorning } from './format';
import { flushAccepts, startAnswer } from './pendingAccept';
import { useAcceptDecision } from '../work/acceptDecision';
import { answerAgentQuestion } from '../agents/api';
import { rememberQuestion } from '../agents/questions';
import { restoreNeedsYou, resolveNeedsYou, type Queue } from './needsYou';
import { waitingHash } from '../assistant/waitingHash';

const apiMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

/**
 * What a person does with an item of the queue, shared by the Inbox and Home (#342, F-026 S9/S11).
 * Done, Not now (until tomorrow morning), Decline, Unblock and Accept apply at once and offer Undo (`Z`) as a real reversal: Accept's
 * Undo takes the acceptance back for everyone (founder decision, round 8, #1424; `useAcceptDecision`). Only an agent's question answered
 * with its buttons is held for its window (see `pendingAccept`).
 */
export function useNeedsYouActions(queue: Queue): CardHandlers {
  const toast = useToast();
  // An item opens its source as a reference: the Inbox is where Back returns to (#592).
  const navigate = useFollow();
  const discussDecision = useDiscussDecision();
  const acceptNow = useAcceptDecision(queue.userId);
  // The latest queue without re-creating the handlers (and the keys that use them) on every answer.
  const latest = useRef(queue);
  useEffect(() => { latest.current = queue; });
  // Leaving the place sends what is waiting, so nothing the person said is lost.
  useEffect(() => () => flushAccepts(), []);

  /**
   * Two actions in a row, each one chosen (J, a click on a row, or after the moment of `settle`), share one Undo toast while the first one's is
   * still on screen (personas-34 P2 3): "Accepted, and 1 more", and its Undo (Z) takes every one of them back, the newest first. Undo toasts
   * stay one at a time (#1206), so a second toast never takes away the Undo of the first.
   */
  const chain = useRef<{ undos: (() => void)[] } | null>(null);
  const say = useCallback((options: ToastOptions) => {
    const action = options.action;
    if (!action) { toast(options); return; }
    const undos = [...(chain.current?.undos ?? []), action.onClick];
    const mine = { undos };
    chain.current = mine;
    const more = undos.length - 1;
    toast({
      ...options,
      message: more ? `${options.message}, and ${more} more` : options.message,
      onLeave: () => { if (chain.current === mine) chain.current = null; options.onLeave?.(); },
      action: { ...action, onClick: () => {
        if (chain.current === mine) chain.current = null;
        // What came back is the open item again and takes the next key at once (F-026 §4).
        inboxSettled();
        for (const undo of [...undos].reverse()) undo();
      } },
    });
  }, [toast]);

  /**
   * Stores the choice, shows the toast, and reverses the choice on Undo. Done on a task given to you and on your blocked task finishes the
   * task, and for the person a blocked task waits for it lets the task continue (#1424, round 8): the queue makes that change of the task
   * with the choice, so Undo, `Z` and Put back in "done today" change it back, Blocked again with what it waited for (personas-33).
   */
  const resolve = useCallback((item: NeedsYouItem, command: ResolveNeedsYouCommand, message: string) => {
    const current = latest.current;
    const changesTask = command.action === 'done' && (item.kind === 'task' || item.kind === 'blocked');
    const stored = resolveNeedsYou(item.key, command).then(announceInboxChange);
    const intent = current.hide(item.key, stored);
    stored.catch((error: unknown) => {
      if (!intent.isCurrent()) return;
      current.show(item);
      toast({ message: apiMessage(error, changesTask ? 'That did not work. Open the task to look again.' : 'That did not work. Try again.'), tone: 'danger' });
    });
    say({ message, action: { label: 'Undo', key: 'Z', onClick: () => {
      // Undo may come while the choice is still on its way: the DELETE follows it, and the item is pending until then.
      const restored = stored.then(() => restoreNeedsYou(item.key)).then(announceInboxChange);
      const undoIntent = current.show(item, restored);
      restored.catch((error: unknown) => {
        if (!undoIntent.isCurrent()) return;
        current.hide(item.key);
        current.reload();
        toast({ message: apiMessage(error, changesTask ? 'Undo did not work. Open the task to look again.' : 'Undo did not work. The item is back after a refresh.'), tone: 'danger' });
      });
    } } });
  }, [toast, say]);

  /** The toast of Done, in the words of the change it makes: "#12 moved to Done", "#6 can continue", else "Marked done". */
  const doneWords = (item: NeedsYouItem) => item.kind === 'task' && item.task ? stateWords(item.task, 'done')
    : item.kind === 'blocked' && item.blocked ? (item.blocked.waitedBy ? `#${item.blocked.number} can continue` : stateWords(item.blocked, 'done')) : 'Marked done';

  /**
   * One press, one action (personas-34 P2 3): an action that takes the open item out swaps its neighbour in at once, under the pointer and the
   * keys, so for a moment (`settle.ts`) every action of the Inbox does nothing; the second click of a double-click lands on nothing.
   */
  const once = <A extends unknown[]>(run: (...args: A) => void, takesOut = true) => (...args: A) => {
    if (inboxSettling()) return;
    run(...args);
    if (takesOut) inboxActed();
  };

  return useMemo<CardHandlers>(() => ({
    // For the person a blocked task waits for, Done is what they were asked for: the task resumes. On your blocked task and on a task given
    // to you it finishes the task. For anything else it only clears the item. Each has its Undo (personas-33).
    done: once((item: NeedsYouItem) => resolve(item, { action: 'done' }, doneWords(item))),

    snooze: once((item: NeedsYouItem, choice: SnoozeChoice) => {
      if (choice === 'decline') { resolve(item, { action: 'decline' }, 'Declined for good. Only your Inbox changed'); return; }
      // Not now is one button with no menu (S11): the item comes back tomorrow morning.
      resolve(item, { action: 'snooze', until: tomorrowMorning().toISOString() }, 'Not now. Back tomorrow morning');
    }),

    accept: once((item: NeedsYouItem) => {
      const current = latest.current;
      const decision = item.decision;
      if (!decision) return;
      // Accepted at once, for everyone (round 8, #1424): the item leaves now, and Undo takes the acceptance back.
      let intent: { isCurrent(): boolean } | null = null;
      const sent = acceptNow({ id: decision.id, version: decision.version }, {
        failed: () => { if (!intent?.isCurrent()) return; current.show(item); current.reload(); },
        undoing: (back) => {
          const undoIntent = current.show(item, back);
          // Back at the version the Undo left, so Accept again is not refused as stale.
          back.then((proposed) => { if (undoIntent.isCurrent()) current.show({ ...item, decision: { ...decision, version: proposed.version } }); },
            () => { if (undoIntent.isCurrent()) { current.hide(item.key); current.reload(); } });
        },
      }, say);
      intent = current.hide(item.key, sent);
    }),

    answer: once((item: NeedsYouItem, optionIndex: number) => {
      const current = latest.current;
      const question = item.agentQuestion;
      const option = question?.options[optionIndex];
      if (!question || option === undefined) return;
      // An answer is the person's reply in the agent's thread and is given once, so Undo holds it back for the window (S14, rule 6).
      const handle = startAnswer(question.id, async (key, keepalive) => { rememberQuestion(await answerAgentQuestion(question.id, { optionIndex }, key, keepalive)); }, (outcome) => {
        if (outcome === 'accepted') announceAcceptedInboxItem(current.userId, item.key);
        announceInboxChange();
        if (outcome === 'accepted') return;
        current.reload();
        toast(outcome === 'conflict'
          ? { message: 'This question was answered already, or you can no longer answer it. Open it to look again.', tone: 'danger' }
          : { message: 'Your answer didn’t send. Nothing changed. Try again.', tone: 'danger' });
      });
      current.hide(item.key);
      toast({ message: `Answered: ${option}`, tone: 'success', onLeave: handle.send, action: { label: 'Undo', key: 'Z', onClick: () => {
        inboxSettled();
        if (handle.undo()) { current.show(item); return; }
        toast({ message: 'Your answer was already sent. Reply in the thread to change it.' });
      } } });
    }),

    open: once((item: NeedsYouItem, reply = false) => {
      // A decision opens where it opens from everywhere (Search, a notification, its card): over its space's conversation (`decisionAppPath`).
      // A task or a decision opens in its space with its own address and history entry (F-026 §4, persona round 30 P2 2): a reload keeps it,
      // and closing it (Esc, ×) or Back returns to the Inbox with its open item. `openPushed`: closing goes Back over that entry.
      if (item.kind === 'decision' && item.decision && item.project) void navigate(decisionAppPath(item.project.id, item.decision.id), { state: { openPushed: true } });
      else if (item.kind === 'blocked' && item.blocked && item.project) void navigate(`/projects/${item.project.id}/tasks?open=work:${item.blocked.workId}`, { state: { openPushed: true } });
      // A task given to you: opening it takes it out of the Inbox (#1424 C, `useGivenTaskOpened`).
      else if (item.kind === 'task' && item.task && item.project) void navigate(`/projects/${item.project.id}/tasks?open=work:${item.task.workId}`, { state: { openPushed: true } });
      // What an agent run waits for opens at its waiting changes, Approve and Skip in view, never at the thread's start (round 15 AI P2-3).
      else if (item.assistantChanges) void navigate(`${item.url}${waitingHash(item.assistantChanges.runId)}`, { state: { openPushed: true } });
      // A question, a mention or a reply opens where it is answered, with its own entry too: closing it (Esc, × "Close replies", the sheet's ×)
      // goes Back to the Inbox with its open item, as a decision does (F-026 §4, personas-33 P2 1). Enter, R and Reply open it the same way
      // (personas-34 P2 1): its thread, also when nobody has replied yet (`openThread`), or a direct message, with the cursor in the field
      // there; on a touch screen only Reply puts it there, as a focused field would raise the keyboard over what is being read.
      else if (itemKeys(item, true).reply) {
        const write = reply || !window.matchMedia(MEDIA.touch).matches;
        if (write) awaitField();
        void navigate(item.url, { state: { openThread: true, openPushed: true, ...(write ? { focusComposer: true } : {}) } });
      }
      else void navigate(item.url, { state: { openPushed: true } });
    }, false),

    applyChanges: once((item: NeedsYouItem) => {
      const current = latest.current;
      const changes = item.assistantChanges;
      if (!changes) return;
      // Approve all (F-036 AG-7): each change is applied with every check again; one that changed since says so and applies nothing.
      const applied = applyRunChanges(changes.runId);
      const intent = current.hide(item.key, applied);
      applied.then((result) => {
        announceInboxChange();
        const problems = [...new Set(result.changes.map((entry) => entry.message).filter((message): message is string => !!message))];
        toast(problems.length ? { message: problems.join(' · '), tone: 'danger' } : { message: `Approved: ${changes.summary}`, tone: 'success' });
      }, (error: unknown) => {
        if (!intent.isCurrent()) return;
        current.show(item);
        toast({ message: apiMessage(error, 'That did not work. Try again.'), tone: 'danger' });
      });
    }),

    discuss: once((item: NeedsYouItem) => {
      // A decision opens where it is talked about, ready to write (#763 D3); anything else opens its project.
      if (item.decision && item.project) { void discussDecision(item.project.id, item.decision.id); return; }
      void navigate(item.project ? `/projects/${item.project.id}` : item.url);
    }, false),

    unblock: once((item: NeedsYouItem) => {
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
      // The words of the task panel's Unblock and of every state change (#763 C2, personas-30): "#6 moved to Doing".
      say({ message: stateWords(blocked, status), action: { label: 'Undo', key: 'Z', onClick: () => {
        const restored = changed.then((work) => updateWork(work, { status: 'blocked', ...(blocked.blocker ? { blocker: blocked.blocker } : {}), ...(blocked.waitingForUserId ? { waitingFor: { kind: 'human' as const, id: blocked.waitingForUserId } } : {}), ...(blocked.waitingOn ? { waitingOn: blocked.waitingOn } : {}), restore: true }, crypto.randomUUID())).then(announceInboxChange);
        const undoIntent = current.show(item, restored);
        restored.catch(() => {
          if (!undoIntent.isCurrent()) return;
          current.reload();
          toast({ message: 'Undo did not work. Open the task to block it again.', tone: 'danger' });
        });
      } } });
    }),
  }), [resolve, acceptNow, toast, say, navigate, discussDecision]);
}
