import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type ConversationMessage, type AssistantActivity, type AssistantAnswer, type AssistantProposal, type AssistantRun, type AssistantRunKind, type PersonalAssistantStatus } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { reply } from '../conversations/api';
import { getProjectAgents } from '../agents/api';
import {
  acceptProposal, askAssistant, dismissProposal, getAssistantActivity, getAssistantStatus, getRun, listAnswers, listOwnRuns, listProposals, resumeAssistant, retryRun, stopRun,
} from './api';
import { isWorking } from './format';
import { rememberAskedConversation } from './lastAsked';

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
  /** The next request, waiting for the working one to end (AST-6 queue): "Next: '…'. It starts when this one ends · Cancel". */
  queued: AssistantRun | null;
  cancelQueued(): Promise<void>;
  /** The queued request waits behind a background run of the owner: "Finishing your Morning summary first… [ Stop the summary ]". */
  stopBehind(): Promise<void>;
  /** Other people's assistants working here right now, by name only: "Ada's assistant is working…" (AST-6). */
  others: AssistantActivity['working'];
  /** Changes whenever the shared part of the conversation was refreshed: an assistant started or stopped working, an answer arrived. */
  tick: number;
  /**
   * Whether the person's assistant is a member of this project (F-027 AST-10 "Delight details": suggestions only where it
   * is): null while unknown or when they have no assistant in this workspace. `requested`: they asked, a manager has not yet.
   */
  member: boolean | null;
  requested: boolean;
  refreshMembership(): void;
  ask(prompt: string, options?: { kind?: AssistantRunKind; continuesRunId?: string; clientRunId?: string }): Promise<AssistantRun>;
  stop(): Promise<void>;
  retry(runId: string): Promise<void>;
  dismissRun(): void;
  resume(): Promise<void>;
  decide(proposal: AssistantProposal, decision: 'accept' | 'dismiss'): Promise<AssistantProposal>;
  refreshStatus(): void;
}

export function useConversationAssistant({ meId, meName, projectId, conversationId, onPosted, enabled = true }: {
  meId: string; meName?: string; projectId: string; conversationId: string | null;
  /** False while the workspace's AI is off (F-029, #614): nothing AI is asked for, and only the committed answers (history) are read. */
  enabled?: boolean;
  /** The request as it was posted to the conversation (the stream message of Journey 1 step 6), so the pane can show it at once. */
  onPosted?: (message: ConversationMessage) => void;
}): ConversationAssistant {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [membership, setMembership] = useState<{ member: boolean | null; requested: boolean }>({ member: null, requested: false });
  const [answers, setAnswers] = useState<AssistantAnswer[]>([]);
  const [proposals, setProposals] = useState(new Map<string, AssistantProposal>());
  const [run, setRun] = useState<AssistantRun | null>(null);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);
  const [others, setOthers] = useState<AssistantActivity['working']>([]);
  const [tick, setTick] = useState(0);
  const [queued, setQueued] = useState<AssistantRun | null>(null);
  const queuedRef = useRef(queued);
  useEffect(() => { queuedRef.current = queued; }, [queued]);

  const refreshStatus = useCallback(() => { if (enabled) getAssistantStatus().then(setStatus).catch(() => { /* the ask bar keeps saying it is checking */ }); }, [enabled]);
  const refreshActivity = useCallback(async () => {
    if (!conversationId || !enabled) return;
    try { setOthers((await getAssistantActivity(conversationId)).working.filter((item) => item.ownerId !== meId)); } catch { /* the line is a courtesy; a missing one is not an error */ }
  }, [conversationId, meId, enabled]);
  const hasAssistant = !!status?.enablement;
  const refreshMembership = useCallback(() => {
    if (!enabled) return;
    getProjectAgents(projectId).then((view) => {
      const requested = view.joinRequests?.some((item) => item.ownerUserId === meId && item.state === 'pending') ?? false;
      setMembership({ member: view.assistantJoin ? !view.assistantJoin.canRequest && !requested : null, requested });
    }, () => undefined);
  }, [projectId, meId, enabled]);
  useEffect(() => { if (hasAssistant) refreshMembership(); }, [hasAssistant, refreshMembership]);
  const refreshShared = useCallback(async () => {
    if (!conversationId) return;
    void refreshActivity();
    setTick((value) => value + 1);
    try {
      const [items, drafted] = await Promise.all([allAnswers(conversationId), enabled ? listProposals(projectId) : null]);
      setAnswers(items);
      if (drafted) setProposals(new Map(drafted.items.map((item) => [item.id, item])));
    } catch { /* the conversation itself reports lost access */ }
  }, [conversationId, projectId, refreshActivity, enabled]);

  /** A run changed: keep it while it works or when it ended without an answer; an answer shows in the feed. */
  const track = useCallback((next: AssistantRun) => {
    // A schedule's or the morning summary's silent run only borrows a conversation: it is not this conversation's working line.
    if (next.conversationId !== conversationId || next.silent) return;
    const current = runRef.current;
    // A request behind the working one waits in its own line; it takes over the working line when it starts. It also waits when the
    // lane is held by a background run of the owner, which may belong to no conversation here.
    if (next.status === 'queued' && (next.behind || current && current.id !== next.id && isWorking(current))) { setQueued(next); return; }
    if (queuedRef.current?.id === next.id) {
      setQueued(null);
      if (!isWorking(next)) { refreshStatus(); return; }
    }
    if (isWorking(next)) { setRun(next); return; }
    setRun((current) => (current && current.id !== next.id && isWorking(current) ? current : next.answer ? null : next));
    if (next.answer) void refreshShared();
    refreshStatus();
  }, [conversationId, refreshShared, refreshStatus]);

  useEffect(() => {
    // F-029 (#614): while the workspace's AI is off only the committed answers (conversation history) are read.
    if (!enabled) {
      if (conversationId) allAnswers(conversationId).then(setAnswers).catch(() => undefined);
      return;
    }
    refreshStatus();
    if (conversationId) {
      Promise.all([allAnswers(conversationId), listProposals(projectId)]).then(([items, drafted]) => {
        setAnswers(items);
        setProposals(new Map(drafted.items.map((item) => [item.id, item])));
      }).catch(() => undefined);
      getAssistantActivity(conversationId).then((activity) => setOthers(activity.working.filter((item) => item.ownerId !== meId))).catch(() => undefined);
    }
    // After a reload the working line comes back: the person's own newest run in this conversation.
    listOwnRuns().then((page) => {
      const here = page.items.filter((item) => item.conversationId === conversationId && !item.silent && isWorking(item));
      const working = here.find((item) => item.status !== 'queued');
      const waiting = here.find((item) => item.status === 'queued' && (item.behind || working && item.id !== working.id));
      const active = working ?? here.find((item) => item !== waiting);
      if (active) setRun(active);
      if (waiting) setQueued(waiting);
    }).catch(() => undefined);
  }, [conversationId, projectId, meId, refreshStatus, enabled]);

  useStreamEvents(meId, (event) => {
    if (!enabled) return;
    if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) {
      // Owner-only: another person's run never reaches this stream.
      getRun(event.objectId).then(track).catch(() => undefined);
      return;
    }
    if (event.objectType === 'project' && event.objectId === projectId && event.kind.startsWith('project.assistant_')) void refreshShared();
  }, () => { void refreshShared(); if (enabled && runRef.current) getRun(runRef.current.id).then(track).catch(() => undefined); });

  // A fallback while a run works, in case the stream is reconnecting.
  const working = enabled && !!run && isWorking(run);
  useEffect(() => {
    if (!working || !run) return;
    const timer = window.setInterval(() => { getRun(run.id).then(track).catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [working, run, track]);

  useEffect(() => {
    if (!queued || !enabled) return;
    const timer = window.setInterval(() => { getRun(queued.id).then(track).catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [queued, track, enabled]);

  return {
    // Masked while AI is off: a run, a suggestion or a status read before the flip is not shown.
    status: enabled ? status : null, answers, proposals: enabled ? proposals : new Map<string, AssistantProposal>(), run: enabled ? run : null, queued: enabled ? queued : null,
    others: enabled ? others : [], tick, refreshStatus, member: enabled ? membership.member : null, requested: enabled && membership.requested, refreshMembership,
    async cancelQueued() {
      if (!queued) return;
      track(await stopRun(queued.id));
    },
    async stopBehind() {
      if (!queued?.behind) return;
      await stopRun(queued.behind.runId);
      const next = await getRun(queued.id);
      track(next);
    },
    async ask(prompt, options = {}) {
      if (!conversationId) throw new Error('No conversation');
      const started = await askAssistant(conversationId, {
        clientRunId: options.clientRunId ?? crypto.randomUUID(), kind: options.kind ?? 'ask', prompt,
        ...(options.continuesRunId ? { continuesRunId: options.continuesRunId } : {}),
      });
      track(started);
      rememberAskedConversation(meId, projectId, conversationId);
      // J1 step 6: the request appears in the stream as sent, "@Ada's assistant tidy this project's tasks", so everyone sees what was
      // asked and whose assistant it is. It follows the run (a refused run leaves nothing behind) under the request's own id, so a
      // replay after a lost answer posts it once. A Continue is part of the earlier request and posts nothing.
      if (!options.continuesRunId && meName) {
        const first = meName.trim().split(/\s+/)[0] || meName;
        const posted = await reply(conversationId, { body: `@${first}'s assistant ${prompt}`, clientMessageId: started.clientRunId }).catch(() => null);
        if (posted) onPosted?.(posted);
      }
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
