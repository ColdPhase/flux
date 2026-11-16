import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { listAllDms } from '../api/direct-messages';
import { useStreamEvents } from '../api/stream';
import { useShellData, type DirectMessageSummary } from '../app/data';

// Direct messages have an unread state (founder decision, Hubert, 2026-11-14, #1424 decision 10): a conversation with a message from
// someone else that the person has not read has its name in bold in Messages and on the phone's Spaces tab, as an unread space. The state
// is the server's (`DmSummary.unread`): the shell reads it with the conversations, and this keeps it fresh without reading the whole shell
// again. The open conversation is read while it is open. A message or a reading in one of the person's conversations (on any device: the
// event reaches every tab of every participant) reads the list again, at most once every four seconds; so do focus and leaving a
// conversation, whose last observations then have been saved.

/** Fired when the person's direct messages were read or put back from outside a conversation ("Mark all as read", #1250). */
export const DM_UNREAD_CHANGED = 'flux:dm-unread-changed';

const Unread = createContext<ReadonlyMap<string, number>>(new Map());
const EVENTS = new Set(['dm.message_sent.v1', 'dm.observed.v1']);
/** At most one read of the list in this long, however many messages arrive. */
const PACE_MS = 4000;

export function DmUnreadProvider({ identity, children }: { identity: string; children: ReactNode }) {
  const { directMessages, workspaces } = useShellData();
  const { pathname } = useLocation();
  const open = pathname.match(/^\/dm\/([^/?#]+)/)?.[1] ?? null;
  // What a read of the list answered, for the shell's list it was read beside: a newer shell read is newer than it.
  const [fetched, setFetched] = useState<{ identity: string; base: readonly DirectMessageSummary[]; counts: ReadonlyMap<string, number> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
  const known = useRef(new Set<string>());
  useEffect(() => { known.current = new Set(directMessages.map((dm) => dm.id)); }, [directMessages]);
  // The conversation just left was read here: it stays read until a new message arrives in it, so it never turns bold again from what was
  // known while it was open (the shell's list read again on arrival, or a read asked before its reading was saved).
  const [shown, setShown] = useState(open);
  const [justRead, setJustRead] = useState<string | null>(null);
  if (shown !== open) { setShown(open); if (shown) setJustRead(shown); }
  const read = useCallback(() => {
    last.current = Date.now();
    const base = directMessages;
    void listAllDms(undefined, workspaces).then((list) => setFetched({ identity, base,
      counts: new Map(list.flatMap((dm) => (dm.unread ?? 0) > 0 ? [[dm.id, dm.unread!] as const] : [])) }), () => undefined);
  }, [directMessages, workspaces, identity]);
  const soon = useCallback((wait = 1200) => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; read(); }, Math.max(wait, last.current + PACE_MS - Date.now()));
  }, [read]);
  // Leaving a conversation: what was seen there has been saved by then.
  const was = useRef(open);
  useEffect(() => {
    if (was.current && was.current !== open) soon();
    was.current = open;
  }, [open, soon]);
  useEffect(() => {
    // A hidden tab asks nothing; it looks again when it is shown.
    const visible = () => { if (document.visibilityState === 'visible') soon(0); };
    const now = () => soon(0);
    // Read or put back from outside a conversation (Mark all as read and its Undo): what the list says next is the person's own choice.
    const changed = () => { setJustRead(null); soon(0); };
    window.addEventListener('focus', now);
    window.addEventListener(DM_UNREAD_CHANGED, changed);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', now); window.removeEventListener(DM_UNREAD_CHANGED, changed); document.removeEventListener('visibilitychange', visible);
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
  }, [soon]);
  useStreamEvents(identity, (event) => {
    if (event.objectType === 'dm' && event.kind === 'dm.message_sent.v1') setJustRead((current) => (current === event.objectId ? null : current));
    if (event.objectType === 'dm' && EVENTS.has(event.kind) && known.current.has(event.objectId) && document.visibilityState === 'visible') soon();
  }, () => soon(0));
  const counts = useMemo(() => {
    const current = fetched && fetched.identity === identity && fetched.base === directMessages ? fetched.counts
      : new Map(directMessages.flatMap((dm) => dm.unread > 0 ? [[dm.id, dm.unread] as const] : []));
    return (open && current.has(open)) || (justRead && current.has(justRead)) ? new Map([...current].filter(([id]) => id !== open && id !== justRead)) : current;
  }, [fetched, identity, directMessages, open, justRead]);
  return <Unread.Provider value={counts}>{children}</Unread.Provider>;
}

/** How many messages of each direct message the person has not read; a read one is absent. */
export const useDmUnread = () => useContext(Unread);
