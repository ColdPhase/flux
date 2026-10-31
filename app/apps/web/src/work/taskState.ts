import { useCallback, useRef } from 'react';
import { ME_PATH, type WorkItem, type WorkRowProjection, type WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';
import { useShellData } from '../app/data';
import { noteChange, useToast, useToastScope } from '../ui';
import type { MeResponse } from '../api/auth';
import { undoTaskCreation, updateWork } from './api';
import { STATUS_LABEL, taskNumber } from './format';

// One-tap task state (F-026 S9): the state glyph, or the keys 1-5, change a task's state; a toast says so
// and offers Undo (the key Z), which restores the previous state through the same versioned command.

/** Keys 1-5 in the order of the glyphs in the final design. */
export const STATE_KEYS: Record<string, WorkStatus> = { '1': 'open', '2': 'in_progress', '3': 'blocked', '4': 'done', '5': 'not_pursued' };

/** A tap on the glyph moves work forward: open, in progress, done, then back to open; the other two states re-enter the flow. */
export const nextStatus = (status: WorkStatus): WorkStatus =>
  status === 'open' ? 'in_progress' : status === 'in_progress' ? 'done' : status === 'blocked' ? 'in_progress' : 'open';

export type StateTarget = Pick<WorkRowProjection, 'id' | 'number' | 'title' | 'status' | 'blocker' | 'version'> & Partial<Pick<WorkRowProjection, 'waitingFor'>>;

const lower = (status: WorkStatus) => STATUS_LABEL[status].toLowerCase();

/** A calm sentence for a refused or failed change; the view then shows the stored state. */
export function changeError(error: unknown, item: Pick<StateTarget, 'number' | 'title'>) {
  const name = `${taskNumber(item)} “${item.title}”`;
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return `${name} was changed by someone else a moment ago, so it was not changed.`;
  if (error instanceof ApiError && error.code === 'TASK_PREREQUISITES_UNMET') return `${name} can start or finish only when every task it waits for is done.`;
  if (error instanceof ApiError && error.status === 404) return `${name} is no longer available to you.`;
  if (error instanceof ApiError && error.status === 403) return 'You can read this project but not change it.';
  if (error instanceof NetworkError) return `Flux could not be reached, so ${name} was not changed. Try again when you are online.`;
  return `${name} could not be changed. Its current state is shown; try again.`;
}

/** The one phrasing of a state change, on the board, the list and the panel (#763 C2): "#6 done", "#6 is now in progress". */
export const stateWords = (item: Pick<StateTarget, 'number'>, status: WorkStatus) =>
  status === 'done' ? `${taskNumber(item)} done` : `${taskNumber(item)} is now ${lower(status)}`;

/** What Undo sends to put a task back as it was before a state change: a put-back blocker and person are not said again. */
export function restoreOf(item: Pick<StateTarget, 'status' | 'blocker'> & Partial<Pick<StateTarget, 'waitingFor'>>) {
  const blockedBack = item.status === 'blocked' && (item.blocker || item.waitingFor);
  return { status: item.status, ...(item.status === 'blocked' && item.blocker ? { blocker: item.blocker } : {}),
    ...(item.status === 'blocked' && item.waitingFor ? { waitingFor: { kind: 'human' as const, id: item.waitingFor.id } } : {}),
    ...(blockedBack ? { restore: true as const } : {}) };
}

/**
 * Changes a task's state and shows "#6 done" with Undo. `saved` receives each stored result (the change and its undo)
 * so the caller can show it before its own reads catch up. Resolves to the stored task, or null when refused.
 * `offer` shows the same toast for a change the caller stored itself (a drag or "Move to…" on the board).
 */
export function useStateChanges(saved: (item: WorkItem) => void, done: () => void) {
  const toast = useToast();
  const { me } = useShellData();
  const userId = me.user.id;
  const sessionId = me.session.id;
  const currentScope = useToastScope();
  // A toast and its Undo outlive the page, not the session: whatever completes or is pressed after the
  // account changed (or ended) does nothing and shows nothing of the earlier person's.
  const sameSession = useCallback(async () => {
    if (!currentScope()) return false;
    try {
      const active = await request<MeResponse>(ME_PATH);
      return currentScope() && active.user.id === userId && active.session.id === sessionId;
    } catch (cause) {
      // Only a definite ended session retires this last known identity. A network
      // or server failure must keep the actual state-change error/success visible.
      return currentScope() && !(cause instanceof ApiError && cause.status === 401);
    }
  }, [currentScope, sessionId, userId]);
  const busy = useRef(new Set<string>());
  const offer = useCallback((item: StateTarget, stored: WorkItem, status: WorkStatus) => {
    toast({
      message: stateWords(item, status), tone: 'neutral', mascot: status === 'done' ? 'wink' as const : undefined,
      action: {
        label: 'Undo', key: 'Z',
        onClick: () => {
          const back = restoreOf(item);
          void (async () => {
            if (!(await sameSession())) return;
            try {
              const restored = await updateWork(stored, back, crypto.randomUUID());
              if (!(await sameSession())) return;
              noteChange(restored.id);
              saved(restored);
              toast({ message: `${taskNumber(item)} back to ${lower(item.status)}` });
            } catch (cause) {
              if (await sameSession()) toast({ message: changeError(cause, item), tone: 'danger' });
            } finally {
              done();
            }
          })();
        },
      },
    });
  }, [saved, done, toast, sameSession]);
  const change = useCallback(async (item: StateTarget, status: WorkStatus): Promise<WorkItem | null> => {
    if (status === item.status || busy.current.has(item.id)) return null;
    busy.current.add(item.id);
    try {
      const stored = await updateWork(item, { status }, crypto.randomUUID());
      if (!(await sameSession())) return null;
      noteChange(stored.id);
      saved(stored);
      offer(item, stored, status);
      return stored;
    } catch (cause) {
      if (await sameSession()) toast({ message: changeError(cause, item), tone: 'danger' });
      return null;
    } finally {
      busy.current.delete(item.id);
      done();
    }
  }, [saved, done, toast, sameSession, offer]);
  return { change, offer };
}

/** The state change alone (the list, the glyph, the keys): see `useStateChanges`. */
export function useStateChange(saved: (item: WorkItem) => void, done: () => void) {
  return useStateChanges(saved, done).change;
}

/**
 * The toast after a person creates a task (#763 B1, principle 6): "Task #13 created" with Undo (Z) on every create
 * path, while the server says this reader may still undo the creation. Undo is the #238 creation Undo: the task stays
 * as read-only history and leaves the board, counts and choosers.
 */
export function useCreatedToast(done?: () => void) {
  const toast = useToast();
  const currentScope = useToastScope();
  return useCallback((item: WorkItem) => {
    const message = `Task ${taskNumber(item)} created`;
    if (!item.creationUndo?.eligible) { toast({ message, tone: 'success', timeout: 4000 }); return; }
    const commandId = crypto.randomUUID();
    toast({
      message, tone: 'neutral', timeout: 8000,
      action: {
        label: 'Undo', key: 'Z',
        onClick: () => {
          void (async () => {
            try {
              await undoTaskCreation(item, commandId);
              if (currentScope()) toast({ message: `${taskNumber(item)} creation undone` });
            } catch (cause) {
              if (!currentScope()) return;
              toast({ tone: 'danger', message: cause instanceof ApiError && cause.status === 409
                ? `${taskNumber(item)} has already changed or been used, so it stays.` : changeError(cause, item) });
            } finally { done?.(); }
          })();
        },
      },
    });
  }, [toast, currentScope, done]);
}
