import { useCallback, useRef } from 'react';
import type { WorkItem, WorkRowProjection, WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError, request } from '../api/client';
import { useShellData } from '../app/data';
import { useToast } from '../ui';
import { updateWork } from './api';
import { STATUS_LABEL, taskNumber } from './format';

// One-tap task state (F-026 S9): the state glyph, or the keys 1-5, change a task's state; a toast says so
// and offers Undo (the key Z), which restores the previous state through the same versioned command.

/** Keys 1-5 in the order of the glyphs in the final design. */
export const STATE_KEYS: Record<string, WorkStatus> = { '1': 'open', '2': 'in_progress', '3': 'blocked', '4': 'done', '5': 'not_pursued' };

/** A tap on the glyph moves work forward: open, in progress, done, then back to open; the other two states re-enter the flow. */
export const nextStatus = (status: WorkStatus): WorkStatus =>
  status === 'open' ? 'in_progress' : status === 'in_progress' ? 'done' : status === 'blocked' ? 'in_progress' : 'open';

export type StateTarget = Pick<WorkRowProjection, 'id' | 'number' | 'title' | 'status' | 'blocker' | 'version'>;

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

/**
 * Changes a task's state and shows "#6 done" with Undo. `saved` receives each stored result (the change and its undo)
 * so the caller can show it before its own reads catch up. Resolves to the stored task, or null when refused.
 */
export function useStateChange(saved: (item: WorkItem) => void, done: () => void) {
  const toast = useToast();
  const userId = useShellData().me.user.id;
  // A toast and its Undo outlive the page, not the session: whatever completes or is pressed after the
  // account changed (or ended) does nothing and shows nothing of the earlier person's.
  const sameSession = useCallback(async () => {
    try { return (await request<{ user: { id: string } }>('/api/v1/me')).user.id === userId; } catch { return false; }
  }, [userId]);
  const busy = useRef(new Set<string>());
  return useCallback(async (item: StateTarget, status: WorkStatus): Promise<WorkItem | null> => {
    if (status === item.status || busy.current.has(item.id)) return null;
    busy.current.add(item.id);
    try {
      const stored = await updateWork(item, { status }, crypto.randomUUID());
      if (!(await sameSession())) return null;
      saved(stored);
      toast({
        message: `${taskNumber(item)} ${lower(status)}`, tone: 'neutral',
        action: {
          label: 'Undo',
          onClick: () => {
            const back = { status: item.status, ...(item.status === 'blocked' && item.blocker ? { blocker: item.blocker } : {}) };
            void (async () => {
              if (!(await sameSession())) return;
              try {
                const restored = await updateWork(stored, back, crypto.randomUUID());
                if (!(await sameSession())) return;
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
      return stored;
    } catch (cause) {
      if (await sameSession()) toast({ message: changeError(cause, item), tone: 'danger' });
      return null;
    } finally {
      busy.current.delete(item.id);
      done();
    }
  }, [saved, done, toast, sameSession]);
}
