import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ASSISTANT_RUN_CHANGED_EVENT } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { listAgentChats } from './api';

// The unread dot of an agent's private chat (#919, F-036 AG-7): its answers and its reports (one line when a run on a task ends)
// arrive in its chat and nowhere else: never in the Inbox. The sidebar and the Messages list show the dot; opening the chat reads it.

const UnreadAgents = createContext<ReadonlySet<string>>(new Set());

/** The agents whose chat has something the person has not read, as the shell last saw it. The chat that is open is read as it arrives, so it has no dot. */
export function AgentChatDotsProvider({ identity, children }: { identity: string; children: ReactNode }) {
  const [unread, setUnread] = useState<{ identity: string; agents: ReadonlySet<string> } | null>(null);
  const { pathname } = useLocation();
  const open = pathname.match(/^\/agents\/([^/]+)/)?.[1] ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    void listAgentChats().then((chats) => setUnread({ identity, agents: new Set(chats.filter((chat) => chat.unread > 0).map((chat) => chat.agentId)) }), () => undefined);
  }, [identity]);
  // The worker writes a report shortly after the run ends, and an open chat reads itself: look again after a short pause.
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 1200);
  }, [refresh]);
  useEffect(() => { refresh(); }, [refresh, pathname]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    const interval = setInterval(refresh, 120_000);
    return () => { window.removeEventListener('focus', refresh); clearInterval(interval); if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);
  useStreamEvents(identity, (event) => { if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) soon(); }, refresh);
  const agents = useMemo(() => {
    const known = unread?.identity === identity ? unread.agents : new Set<string>();
    return open && known.has(open) ? new Set([...known].filter((id) => id !== open)) : known;
  }, [unread, identity, open]);
  return <UnreadAgents.Provider value={agents}>{children}</UnreadAgents.Provider>;
}

/** Whether this agent's chat has something unread, for its row in the sidebar and in Messages. */
export const useAgentUnread = (agentId: string) => useContext(UnreadAgents).has(agentId);
