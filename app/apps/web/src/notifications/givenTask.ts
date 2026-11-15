import { useEffect } from 'react';
import { markInboxRead } from './api';
import { getNeedsYou, leaveQueues } from './needsYou';

/**
 * Opening a task someone gave you takes its Task item out of the Inbox (founder decision, Hubert, 2026-11-15, #1424 C): wherever the task
 * was opened from (the Inbox, Tasks, Search, a link), the panel showing a task of yours that has not started reads the notification that
 * gave it to you, and every open queue loses the item at once. Starting, finishing or giving it away takes it out on the server.
 */
export function useGivenTaskOpened(userId: string, task: { id: string; status: string; owner: { kind: string; id: string } | null }) {
  const candidate = task.status === 'open' && task.owner?.kind === 'human' && task.owner.id === userId;
  const id = task.id;
  useEffect(() => {
    if (!candidate) return;
    // The queue's read is shared with the sidebar's count: it is not aborted here, only ignored once the panel moved on.
    let gone = false;
    void getNeedsYou().then((response) => {
      if (gone) return;
      const keys = response.items.filter((item) => item.kind === 'task' && item.task?.workId === id).map((item) => item.key);
      if (!keys.length) return;
      void Promise.allSettled(keys.map((key) => markInboxRead(key.slice('note:'.length)))).then(() => leaveQueues(userId, keys));
    }, () => undefined);
    return () => { gone = true; };
  }, [userId, id, candidate]);
}
