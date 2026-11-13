import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useToast } from '../ui';
import { anchorPath } from './anchors';
import { getSession } from './api';
import { useLive } from './LiveProvider';

/**
 * Join a call from anywhere it is announced (F-041): the Inbox's call items, and later the in-app notice card (#1243). It opens the call's
 * place and joins with every device off. A call that ended meanwhile says so.
 */
export function useJoinCall(): (call: { projectId: string; sessionId: string }) => Promise<void> {
  const live = useLive();
  const navigate = useNavigate();
  const toast = useToast();
  return useCallback(async (call) => {
    try {
      const session = await getSession(call.sessionId);
      if (session.projectId !== call.projectId || session.state !== 'available') throw new Error('ended');
      navigate(anchorPath(session));
      await live.join(session);
    } catch {
      toast({ message: 'This call has ended. Anything people saved is in the space as usual.' });
    }
  }, [live, navigate, toast]);
}
