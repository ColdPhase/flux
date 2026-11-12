import { useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import { READ_ALL_PATH, READ_ALL_UNDO_PATH, type ReadAllResult, type ReadAllUndo } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { AGENT_CHATS_CHANGED } from '../my-agents/AgentChatDots';
import { useToast } from '../ui';
import { forgetProjectNews } from './projectNews';

/**
 * "Mark all as read" (#1250): one action, in the Spaces heading's ⋯ and in the Inbox's, for every space and every chat with an agent.
 * It never clears the Inbox: what needs an action stays. The toast has Undo, which waits for the save and puts back what it read,
 * except a space the person opened since (the server leaves a space that something moved since). The sidebar and the lists read the
 * news again at once.
 */
const apiMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

function reread() {
  forgetProjectNews();
  window.dispatchEvent(new Event(AGENT_CHATS_CHANGED));
}

/** The spaces opened since the latest Mark all as read: opening one reads it, and Undo must not make it unread again. */
let opened = new Set<string>();

export function useMarkAllRead() {
  const toast = useToast();
  // Every place that offers the action sees the person move about; the shell's is always mounted.
  const here = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1];
  useEffect(() => { if (here) opened.add(here); }, [here]);
  return useCallback(() => {
    // The space the person is in now is one they are reading.
    const seen = opened = new Set<string>(here ? [here] : []);
    const done = request<ReadAllResult>(READ_ALL_PATH, { method: 'POST' }).then((result) => { reread(); return result.undo; });
    done.catch((error: unknown) => toast({ message: apiMessage(error, 'That did not work. Try again.'), tone: 'danger' }));
    // The toast is up at once; Undo follows the save.
    toast({ message: 'Marked all as read', action: { label: 'Undo', key: 'Z', onClick: () => {
      void done.then((undo: ReadAllUndo) => request<null>(READ_ALL_UNDO_PATH, { method: 'POST', body: { ...undo, spaces: undo.spaces.filter((id) => !seen.has(id)) } })).then(reread).catch((error: unknown) =>
        toast({ message: apiMessage(error, 'Undo did not work. Try again.'), tone: 'danger' }));
    } } });
  }, [toast, here]);
}
