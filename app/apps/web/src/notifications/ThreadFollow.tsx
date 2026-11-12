import { useCallback, useEffect, useRef, useState } from 'react';
import { PROJECT_NOTIFICATIONS_CHANGED_EVENT } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Button, PanelActions, useToast } from '../ui';
import { getFollow, setFollow } from './api';

/**
 * Follow and Following in a thread's header (#1249): whether this thread's replies notify the person. They follow it without choosing
 * when they started it, wrote in it or were mentioned in it; Following stops its replies, and Follow brings them back. It reads and
 * writes the same preferences the Inbox, push and email use (`/notification-preferences/follows`), and another tab's change arrives
 * as a stream event of the space and is read again; nothing polls. Drawn in the panel's head, where its quiet actions sit.
 */
export function ThreadFollow({ conversationId, projectId }: { conversationId: string; projectId: string }) {
  const identity = useShellData().me.user.id;
  const toast = useToast();
  const [state, setState] = useState<{ id: string; following: boolean } | null>(null);
  // A newer read or choice is the truth: an older answer arriving late never undoes it.
  const version = useRef(0);
  const read = useCallback(() => {
    const mine = ++version.current;
    void getFollow(conversationId).then((answer) => {
      if (mine === version.current) setState({ id: conversationId, following: answer.following });
    }, () => undefined);
  }, [conversationId]);
  useEffect(read, [read]);
  useStreamEvents(identity, (event) => { if (event.kind === PROJECT_NOTIFICATIONS_CHANGED_EVENT && event.objectId === projectId) read(); }, read);

  const known = state?.id === conversationId ? state.following : null;
  if (known === null) return null;
  const choose = async () => {
    const mine = ++version.current;
    setState({ id: conversationId, following: !known });
    try {
      const answer = await setFollow({ conversationId, following: !known });
      if (mine === version.current) setState({ id: conversationId, following: answer.following });
    } catch (error) {
      if (mine === version.current) setState({ id: conversationId, following: known });
      toast({ message: error instanceof ApiError && error.status < 500 && error.status !== 404 ? error.message : known ? 'Could not unfollow. Try again.' : 'Could not follow. Try again.', tone: 'danger' });
    }
  };
  return (
    <PanelActions>
      <Button variant="quiet" size="sm" icon={known ? 'check' : 'plus'} className="thread-follow" data-following={known ? '' : undefined}
        title={known ? 'You get a notice for each reply. Select to stop.' : 'Get a notice for each reply'} onClick={() => void choose()}>
        {known ? 'Following' : 'Follow'}
      </Button>
    </PanelActions>
  );
}
