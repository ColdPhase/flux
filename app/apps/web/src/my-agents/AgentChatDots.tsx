import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ASSISTANT_RUN_CHANGED_EVENT } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { listAgentChats } from './api';

// The unread dot of an agent's private chat (#919, F-036 AG-7): its answers and its reports (one line when a run on a task ends)
// arrive in its chat and nowhere else: never in the Inbox. The sidebar and the Messages list show the dot; opening the chat reads it.

/** Fired when the chats were read or put back from outside a chat ("Mark all as read", #1250): the dots read again at once. */
export const AGENT_CHATS_CHANGED = 'flux:agent-chats-changed';

const UnreadAgents = createContext<ReadonlySet<string>>(new Set());

/** The agents whose chat has something the person has not read, as the shell last saw it. The chat that is open is read as it arrives, so it has no dot. */
export function AgentChatDotsProvider({ identity, children }: { identity: string; children: ReactNode }) {
  const [unread, setUnread] = useState<{ identity: string; agents: ReadonlySet<string> } | null>(null);
  const { pathname } = useLocation();
  const open = pathname.match(/^\/agents\/([^/]+)/)?.[1] ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
  const read = useCallback((fresh: boolean) => {
    last.current = Date.now();
    void listAgentChats(undefined, fresh).then((chats) => setUnread({ identity, agents: new Set(chats.filter((chat) => chat.unread > 0).map((chat) => chat.agentId)) }), () => undefined);
  }, [identity]);
  // A refresh (focus, an event, the poll) reads; a move to another page may take the kept answer (#862).
  const refresh = useCallback(() => read(true), [read]);
  // The worker writes a report shortly after the run ends, and an open chat reads itself: look again after a short pause. A running agent
  // records an event for each step (the stream carries identifiers only, so a report cannot be told from a step), so looks are at most one
  // every ten seconds: one is always pending, never one per event.
  const soon = useCallback(() => {
    if (timer.current) return;
    const wait = Math.max(1200, last.current + 10_000 - Date.now());
    timer.current = setTimeout(() => { timer.current = null; refresh(); }, wait);
  }, [refresh]);
  useEffect(() => { read(false); }, [read, pathname]);
  useEffect(() => {
    // A hidden tab asks nothing; it looks again when it is shown.
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener(AGENT_CHATS_CHANGED, refresh);
    document.addEventListener('visibilitychange', visible);
    // Also while the live stream is open (#862): a chat read on another device sends this tab no event. Half a request a minute.
    const interval = setInterval(visible, 120_000);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener(AGENT_CHATS_CHANGED, refresh); document.removeEventListener('visibilitychange', visible); clearInterval(interval); if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [refresh]);
  useStreamEvents(identity, (event) => { if (event.kind === ASSISTANT_RUN_CHANGED_EVENT && document.visibilityState === 'visible') soon(); }, refresh);
  const agents = useMemo(() => {
    const known = unread?.identity === identity ? unread.agents : new Set<string>();
    return open && known.has(open) ? new Set([...known].filter((id) => id !== open)) : known;
  }, [unread, identity, open]);
  return <UnreadAgents.Provider value={agents}>{children}</UnreadAgents.Provider>;
}

/** Whether this agent's chat has something unread, for its row in the sidebar and in Messages. */
export const useAgentUnread = (agentId: string) => useContext(UnreadAgents).has(agentId);
