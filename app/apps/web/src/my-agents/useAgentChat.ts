import { useCallback, useEffect, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type AgentChatMessage, type AssistantRun, type PersonalAssistantStatus } from '@flux/contracts';
import { streamLive, useStreamEvents } from '../api/stream';
import { askAssistant, getAgentStatus, listPlaceRuns, retryRun, stopRun } from '../assistant/api';
import { isWorking } from '../assistant/format';
import { listAgentChatMessages, readAgentChat } from './api';

// The private chat with one of the person's agents (#842, F-036 AG-4): what they said to it and what it answered, one run each, oldest first.
// Nobody else sees any of it; there is no Show everyone here, and no space: the agent reads what its owner can see.

const LATEST = 50;

export function useAgentChat(agentId: string, meId: string) {
  const [runs, setRuns] = useState<AssistantRun[] | null>(null);
  const [lines, setLines] = useState<AgentChatMessage[]>([]);
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  // What the chat's neighbours (the schedules) read again with: the stream's events and the person's own doing, not the timer below.
  const [signal, setSignal] = useState(0);
  const refresh = useCallback(() => { setReads((value) => value + 1); setSignal((value) => value + 1); }, []);
  useEffect(() => {
    let alive = true;
    listPlaceRuns({ kind: 'chat', agentId }, { limit: LATEST })
      .then(async (page) => {
        const said = await listAgentChatMessages(agentId).catch(() => null);
        if (!alive) return;
        setRuns(page.items.reverse());
        if (said) setLines(said);
        setFailed(false);
        // Opening the chat, or having it open when something arrives, reads it.
        void readAgentChat(agentId).catch(() => undefined);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [agentId, reads]);
  useEffect(() => {
    let alive = true;
    // This agent's own status (C-3): only its own connection pauses it, not Assistant's.
    getAgentStatus(agentId).then((value) => { if (alive) setStatus(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [agentId, reads]);
  useStreamEvents(meId, (event) => { if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) refresh(); }, refresh);
  // A fallback while the agent works, in case the stream is reconnecting.
  const working = !!runs?.some(isWorking);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { if (!streamLive()) setReads((value) => value + 1); }, 4000);
    return () => window.clearInterval(timer);
  }, [working]);

  return {
    runs, lines, status, failed, working, refresh, version: signal,
    async send(prompt: string) {
      const started = await askAssistant({ kind: 'chat', agentId }, { clientRunId: crypto.randomUUID(), kind: 'ask', prompt });
      setRuns((items) => [...(items ?? []).filter((item) => item.id !== started.id), started]);
      refresh();
    },
    async stop(run: AssistantRun) { await stopRun(run.id); refresh(); },
    async retry(run: AssistantRun) { await retryRun(run.id, crypto.randomUUID()); refresh(); },
  };
}
export type AgentChat = ReturnType<typeof useAgentChat>;
