import { useEffect } from 'react';
import { useToast } from '../ui';
import { INBOX_ANSWERED, announceInboxChange } from './api';
import { leaveQueues, restoreNeedsYou } from './needsYou';

/**
 * A reply answers what its author was asked or mentioned in that conversation (#1170): the server takes those items out of their
 * Inbox as Done does, and the shell says so once, wherever the reply was written, with Undo (`Z`) bringing them back.
 */
export function useAnsweredInbox(userId: string) {
  const toast = useToast();
  useEffect(() => {
    const answered = (event: Event) => {
      const keys = (event as CustomEvent<readonly string[]>).detail;
      if (!keys?.length) return;
      leaveQueues(userId, keys);
      toast({ message: 'Replied. Out of your Inbox', action: { label: 'Undo', key: 'Z', onClick: () => {
        Promise.all(keys.map((key) => restoreNeedsYou(key))).then(announceInboxChange, () => {
          announceInboxChange();
          toast({ message: 'Undo did not work. Open the Inbox and try again.', tone: 'danger' });
        });
      } } });
    };
    window.addEventListener(INBOX_ANSWERED, answered);
    return () => window.removeEventListener(INBOX_ANSWERED, answered);
  }, [userId, toast]);
}
