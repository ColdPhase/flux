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
  // The runs were read and the agent's own lines were not: the history is incomplete, which is never shown as an empty one (#1369).
  const [incomplete, setIncomplete] = useState(false);
  const [reads, setReads] = useState(0);
  // When the person last had this chat open, as it was when they opened it now (#1246): what the agent said after is new to them. The chat reads
  // itself (below), which moves it; the first read is the one that tells where they left off. Null: never opened, so all the agent said is new.
  const [opening, setOpening] = useState<{ since: string | null } | null>(null);
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
        if (said) setLines(said.items);
        setIncomplete(!said);
        setOpening((current) => current ?? { since: said?.readAt ?? null });
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
    runs, lines, status, failed, incomplete, working, refresh, version: signal, opening,
    /** The words and the files staged in this chat (#1438, C-64); the same `clientRunId` again after a lost answer finds the same request. */
    async send(prompt: string, attachmentIds: readonly string[] = [], clientRunId: string = crypto.randomUUID()) {
      const started = await askAssistant({ kind: 'chat', agentId }, { clientRunId, kind: 'ask', prompt, ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}) });
      setRuns((items) => [...(items ?? []).filter((item) => item.id !== started.id), started]);
      refresh();
    },
    async stop(run: AssistantRun) { await stopRun(run.id); refresh(); },
    async retry(run: AssistantRun) { await retryRun(run.id, crypto.randomUUID()); refresh(); },
  };
}
export type AgentChat = ReturnType<typeof useAgentChat>;
