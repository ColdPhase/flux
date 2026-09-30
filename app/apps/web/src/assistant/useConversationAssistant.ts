import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type AssistantAnswer, type AssistantProposal, type AssistantRun, type AssistantRunKind, type PersonalAssistantStatus } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import {
  acceptProposal, askAssistant, dismissProposal, getAssistantStatus, getRun, listAnswers, listOwnRuns, listProposals, resumeAssistant, retryRun, stopRun,
} from './api';
import { isWorking } from './format';

// The assistant inside one project conversation (#68 AC-8). The answers and proposals are the
// conversation's shared objects; the status and the working run are the signed-in person's own
// and come only from their own endpoints and their owner-only progress events.

async function allAnswers(conversationId: string) {
  const first = await listAnswers(conversationId);
  if (first.total <= first.items.length) return first.items;
  // Oldest first: show the latest 100 when there are more.
  return (await listAnswers(conversationId, first.total - 100)).items;
}

export interface ConversationAssistant {
  status: PersonalAssistantStatus | null;
  answers: AssistantAnswer[];
  proposals: Map<string, AssistantProposal>;
  /** The signed-in person's latest run here: in flight, or ended without an answer and not yet dismissed. */
  run: AssistantRun | null;
  ask(prompt: string, options?: { kind?: AssistantRunKind; continuesRunId?: string; clientRunId?: string }): Promise<AssistantRun>;
  stop(): Promise<void>;
  retry(runId: string): Promise<void>;
  dismissRun(): void;
  resume(): Promise<void>;
  decide(proposal: AssistantProposal, decision: 'accept' | 'dismiss'): Promise<AssistantProposal>;
  refreshStatus(): void;
}

export function useConversationAssistant({ meId, projectId, conversationId }: { meId: string; projectId: string; conversationId: string | null }): ConversationAssistant {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [answers, setAnswers] = useState<AssistantAnswer[]>([]);
  const [proposals, setProposals] = useState(new Map<string, AssistantProposal>());
  const [run, setRun] = useState<AssistantRun | null>(null);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const refreshStatus = useCallback(() => { getAssistantStatus().then(setStatus).catch(() => { /* the ask bar keeps saying it is checking */ }); }, []);
  const refreshShared = useCallback(async () => {
    if (!conversationId) return;
    try {
      const [items, drafted] = await Promise.all([allAnswers(conversationId), listProposals(projectId)]);
      setAnswers(items);
      setProposals(new Map(drafted.items.map((item) => [item.id, item])));
    } catch { /* the conversation itself reports lost access */ }
  }, [conversationId, projectId]);

  /** A run changed: keep it while it works or when it ended without an answer; an answer shows in the feed. */
  const track = useCallback((next: AssistantRun) => {
    if (next.conversationId !== conversationId) return;
    if (isWorking(next)) { setRun(next); return; }
    setRun((current) => (current && current.id !== next.id && isWorking(current) ? current : next.answer ? null : next));
    if (next.answer) void refreshShared();
    refreshStatus();
  }, [conversationId, refreshShared, refreshStatus]);

  useEffect(() => {
    refreshStatus();
    if (conversationId) {
      Promise.all([allAnswers(conversationId), listProposals(projectId)]).then(([items, drafted]) => {
        setAnswers(items);
        setProposals(new Map(drafted.items.map((item) => [item.id, item])));
      }).catch(() => undefined);
    }
    // After a reload the working line comes back: the person's own newest run in this conversation.
    listOwnRuns().then((page) => {
      const here = page.items.find((item) => item.conversationId === conversationId && isWorking(item));
      if (here) setRun(here);
    }).catch(() => undefined);
  }, [conversationId, projectId, refreshStatus]);

  useStreamEvents(meId, (event) => {
    if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) {
      // Owner-only: another person's run never reaches this stream.
      getRun(event.objectId).then(track).catch(() => undefined);
      return;
    }
    if (event.objectType === 'project' && event.objectId === projectId && event.kind.startsWith('project.assistant_')) void refreshShared();
  }, () => { void refreshShared(); if (runRef.current) getRun(runRef.current.id).then(track).catch(() => undefined); });

  // A fallback while a run works, in case the stream is reconnecting.
  const working = !!run && isWorking(run);
  useEffect(() => {
    if (!working || !run) return;
    const timer = window.setInterval(() => { getRun(run.id).then(track).catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [working, run, track]);

  return {
    status, answers, proposals, run, refreshStatus,
    async ask(prompt, options = {}) {
      if (!conversationId) throw new Error('No conversation');
      const started = await askAssistant(conversationId, {
        clientRunId: options.clientRunId ?? crypto.randomUUID(), kind: options.kind ?? 'ask', prompt,
        ...(options.continuesRunId ? { continuesRunId: options.continuesRunId } : {}),
      });
      track(started);
      return started;
    },
    async stop() {
      if (!run) return;
      track(await stopRun(run.id));
    },
    async retry(runId) {
      track(await retryRun(runId, crypto.randomUUID()));
    },
    dismissRun() { setRun(null); },
    async resume() {
      setStatus(await resumeAssistant());
    },
    async decide(proposal, decision) {
      const decided = await (decision === 'accept' ? acceptProposal(proposal) : dismissProposal(proposal));
      setProposals((current) => new Map(current).set(decided.id, decided));
      return decided;
    },
  };
}
