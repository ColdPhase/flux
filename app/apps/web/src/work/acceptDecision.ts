import { useCallback } from 'react';
import type { Decision } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useToast, type ToastOptions } from '../ui';
import { announceAcceptedInboxItem, announceInboxChange, announceReturnedInboxItem } from '../notifications/api';
import { acceptDecision, unacceptDecision } from './api';
import { holdAccepting } from '../notifications/pendingAccept';

/** What the place that accepts does with each step: its own list or panel follows the decision. */
export interface AcceptSteps {
  /** The server accepted it. */
  accepted?(decision: Decision): void;
  /** Refused or failed: nothing was accepted (`conflict`: someone decided first or it changed). The toast says so. */
  failed?(conflict: boolean): void;
  /** Undo was pressed: `back` settles with the decision proposed again, or rejects when it stays accepted (the toast says so). */
  undoing?(back: Promise<Decision>): void;
}

const conflicting = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 404 || error.status === 403);

/**
 * The Undos of this tab still on their way, by decision: Accept pressed again before one is answered waits for it and sends the version it
 * left, so a quick Z then A is not refused as stale (the card back in the list still has the version from before the accept).
 */
const returning = new Map<string, Promise<Decision>>();

/**
 * Accept works at once everywhere, with a 10 s Undo (founder decision, Hubert, 2026-11-15, round 8, #1424): the Inbox (`A`, the button) and
 * the decision's panel accept the same way. The decision is accepted for everyone the moment Accept is pressed, as a proposal reaches
 * everyone at once (#1424 L), and the toast's Undo takes the acceptance back for everyone (`POST /decisions/:id/unaccept`): proposed again,
 * a decision it replaced current again, the tasks it let continue waiting again. Once something rests on it, it stays, and the toast says so.
 */
export function useAcceptDecision(userId: string) {
  const toast = useToast();
  /** `say`: how the place shows the "Accepted · Undo" toast; the Inbox joins it with the Undo of the action before it (personas-34). */
  return useCallback((decision: Pick<Decision, 'id' | 'version'>, steps: AcceptSteps = {}, say: (options: ToastOptions) => void = toast) => {
    let refused = false;
    const key = `decision:${decision.id}`;
    // Every queue and count of this tab leaves it out while the accept is on its way, and drops it before its next read lands.
    const release = holdAccepting(decision.id);
    const idempotencyKey = crypto.randomUUID();
    const before = returning.get(decision.id);
    const sent = before
      ? before.then((proposed) => acceptDecision({ id: decision.id, version: Math.max(proposed.version, decision.version) }, idempotencyKey),
        () => acceptDecision(decision, idempotencyKey))
      : acceptDecision(decision, idempotencyKey);
    sent.then((accepted) => { announceAcceptedInboxItem(userId, key); release(); announceInboxChange(); steps.accepted?.(accepted); }, (error: unknown) => {
      refused = true;
      release();
      const conflict = conflicting(error);
      steps.failed?.(conflict);
      toast(conflict ? { message: 'This decision changed before it was accepted. Nothing was accepted. Open it to look again.', tone: 'danger' }
        : { message: 'Could not accept. Nothing changed. Try again.', tone: 'danger' });
    });
    let undone = false;
    say({ message: 'Accepted', tone: 'success', action: { label: 'Undo', key: 'Z', onClick: () => {
      if (undone || refused) return;
      undone = true;
      // Pressed before the accept was answered, it is taken back as soon as it is accepted.
      const back = sent.then((accepted) => unacceptDecision(accepted));
      returning.set(decision.id, back);
      const settled = () => { if (returning.get(decision.id) === back) returning.delete(decision.id); };
      back.then(settled, settled);
      steps.undoing?.(back);
      back.then(() => { announceReturnedInboxItem(userId, key); announceInboxChange(); }, (error: unknown) => {
        if (refused) return;
        announceInboxChange();
        toast(conflicting(error) ? { message: 'It is in use now, so it stays accepted.' } : { message: 'It could not be taken back. Open it to look again.', tone: 'danger' });
      });
    } } });
    return sent;
  }, [toast, userId]);
}
