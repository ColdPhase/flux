import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type AssistantAnswer, type AssistantChange, type AssistantRun, type AssistantRunKind, type PersonalAssistantStatus } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import {
  askAssistant, dismissAnswer, getAssistantStatus, getRun, listAnswers, listPlaceRuns, retryRun, showAnswer, stopRun,
  type AskPlace,
} from './api';
import { isWorking } from './format';
import { rememberAskedConversation } from './lastAsked';
import { readRunChanges } from './WaitingChanges';

// The person's own agent asked from one place (#68, #842): a conversation of a space, the space's main conversation, a direct message or the
// agent's private chat. The answer is the asker's alone; Show everyone posts it as their message and Dismiss puts it away. What a place shows is
// the asker's own runs there (`/assistant-runs?…`) and, for a conversation of a space, the answers posted in it (the project's answers and
// proposals). The status and the working run come only from the asker's own endpoints and their owner-only progress events.

async function allAnswers(conversationId: string) {
  const first = await listAnswers(conversationId);
  if (first.total <= first.items.length) return first.items;
  // Oldest first: show the latest 100 when there are more.
  return (await listAnswers(conversationId, first.total - 100)).items;
}

/** Whether a run is one of `/ai`'s or a chat's: its answer is the asker's alone. */
const asked = (run: AssistantRun) => run.kind === 'ask' || run.kind === 'summarize' || run.kind === 'map_thought';
/** Where a run belongs, as `placeKey` says it for a place. */
const runPlaceKey = (run: AssistantRun) => (run.dmId ? `dm:${run.dmId}:${run.dmThreadRootId ?? ''}` : run.projectId === null ? `chat:${run.agentId}` : `space:${run.projectId}:${run.conversationId ?? ''}`);
/** Where a run belongs, as the key that tells two places apart. */
export const placeKey = (place: AskPlace | null) => !place ? '' : place.kind === 'dm' ? `dm:${place.dmId}:${place.threadRootId ?? ''}` : place.kind === 'chat' ? `chat:${place.agentId}` : `space:${place.projectId}:${place.conversationId ?? ''}`;

export interface ConversationAssistant {
  status: PersonalAssistantStatus | null;
  /** What was posted in this conversation as an answer, for everyone who reads it (a schedule's result is not: it goes to its agent's chat, #1104). */
  answers: AssistantAnswer[];
  /** The signed-in person's latest run here: in flight, or ended without an answer and not yet dismissed. */
  run: AssistantRun | null;
  /** The next request, waiting for the working one to end (AST-6 queue): "Next: '…'. It starts when this one ends · Cancel". */
  queued: AssistantRun | null;
  /** Answers only this person can see, oldest first, until they choose Show everyone or Dismiss (#842). In a space one shows once its changes are read, so the card does not grow. */
  privateAnswers: AssistantRun[];
  /** What the answer's run changed, read before the answer showed (a space only). */
  changesOf(runId: string): AssistantChange[];
  cancelQueued(): Promise<void>;
  /** The queued request waits behind a background run of the owner: "Finishing your daily check first… [ Stop it ]". */
  stopBehind(): Promise<void>;
  /** Changes whenever the shared part of the conversation was refreshed: an answer was posted, a run moved, an answer arrived. */
  tick: number;
  ask(prompt: string, options?: { kind?: AssistantRunKind; continuesRunId?: string; clientRunId?: string }): Promise<AssistantRun>;
  stop(): Promise<void>;
  retry(runId: string): Promise<void>;
  /** Puts the line of a run that ended away. */
  dismissRun(): void;
  /** Puts an answer away. */
  dismissPrivate(run: AssistantRun): Promise<void>;
  /** Posts an answer as the person's own message; resolves with the id of that message. */
  show(run: AssistantRun): Promise<string>;
  refreshStatus(): void;
}

export function useConversationAssistant({ meId, place, onShown, enabled = true }: {
  meId: string;
  /** Where the person asks; null while there is no place to ask in (a stream with no space yet). */
  place: AskPlace | null;
  /** False while the space's AI is off (F-029, #614): nothing AI is asked for, and only what was posted (history) is read. */
  enabled?: boolean;
  /** An answer was posted as the person's own message (Show everyone), so the pane can show it at once. */
  onShown?: (messageId: string) => void;
}): ConversationAssistant {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [answers, setAnswers] = useState<AssistantAnswer[]>([]);
  const [mine, setMine] = useState<AssistantRun[]>([]);
  /** When the runs were last read: a run that ended without an answer shows its line for an hour. */
  const [readAt, setReadAt] = useState(0);
  const [tick, setTick] = useState(0);
  /** What answered runs of a space changed, read once the answer arrived: the card shows complete (#842). */
  const [changed, setChanged] = useState<Record<string, AssistantChange[]>>({});
  const key = placeKey(place);
  const placeRef = useRef(place);
  useEffect(() => { placeRef.current = place; });
  /** Runs this tab just started: a read that began before the server took them does not list them, and must not make them vanish. */
  const started = useRef(new Map<string, { run: AssistantRun; at: number }>());
  /** Runs this page started or saw working: their line stays until it is put away. One found already ended shows for an hour after it ended. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const see = useCallback((ids: string[]) => { if (ids.length) setSeen((known) => (ids.every((id) => known.has(id)) ? known : new Set([...known, ...ids]))); }, []);
  const conversationId = place?.kind === 'space' ? place.conversationId : null;
  const projectId = place?.kind === 'space' ? place.projectId : null;

  const refreshStatus = useCallback(() => { if (enabled) getAssistantStatus().then(setStatus).catch(() => { /* the ask bar keeps saying it is checking */ }); }, [enabled]);
  /** The asker's own runs here, newest first; an error keeps what is shown. */
  const refreshRuns = useCallback(async () => {
    const here = placeRef.current;
    if (!here) return;
    try {
      const read = (await listPlaceRuns(here, { limit: 20 })).items.filter((item) => asked(item));
      const now = Date.now();
      see(read.filter(isWorking).map((item) => item.id));
      for (const [id, { at }] of started.current) if (now - at > 10_000 || read.some((item) => item.id === id)) started.current.delete(id);
      const items = [...[...started.current.values()].map(({ run }) => run), ...read];
      if (placeKey(placeRef.current) === placeKey(here)) { setMine(items); setReadAt(now); }
    } catch { /* the conversation itself reports lost access */ }
  }, [see]);
  /** One run of this place, read again: the newest state of a run that moved. */
  const take = useCallback((run: AssistantRun) => {
    if (runPlaceKey(run) !== placeKey(placeRef.current) || !asked(run)) return;
    if (isWorking(run)) see([run.id]);
    const known = started.current.get(run.id);
    if (known) started.current.set(run.id, { ...known, run });
    setMine((items) => [run, ...items.filter((item) => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setReadAt(Date.now());
  }, [see]);
  const refreshShared = useCallback(async () => {
    setTick((value) => value + 1);
    void refreshRuns();
    if (!conversationId) return;
    try {
      setAnswers(await allAnswers(conversationId));
    } catch { /* the conversation itself reports lost access */ }
  }, [conversationId, refreshRuns]);

  useEffect(() => {
    // F-029 (#614): while the space's AI is off only what was posted (conversation history) and the asker's own answers are read.
    if (enabled && key) refreshStatus();
    void refreshRuns();
    if (conversationId) allAnswers(conversationId).then(setAnswers).catch(() => undefined);
  }, [key, conversationId, enabled, refreshStatus, refreshRuns]);

  // The asker's own run moved (their owner-only event), or an answer was posted here: read again.
  useStreamEvents(meId, (event) => {
    if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) { getRun(event.objectId).then(take).catch(() => { void refreshRuns(); }); return; }
    if (!enabled) return;
    if (projectId && event.objectType === 'project' && event.objectId === projectId && event.kind.startsWith('project.assistant_')) void refreshShared();
  }, () => { void refreshShared(); });

  // A fallback while a run works, in case the stream is reconnecting.
  const working = enabled && mine.some(isWorking);
  const workingRef = useRef<AssistantRun[]>([]);
  useEffect(() => { workingRef.current = mine.filter(isWorking); });
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { for (const run of workingRef.current) getRun(run.id).then(take).catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [working, take]);

  const current = mine.filter((item) => !item.shownAt && !item.dismissedAt);
  // The oldest working run holds the owner's lane; a request behind it, or behind a background run of the owner, waits in its own line (AST-6 queue).
  const active = current.filter(isWorking).filter((item) => item.status !== 'queued').at(-1) ?? null;
  const waiting = current.filter((item) => item.status === 'queued').filter((item) => item.behind || (active && item.id !== active.id)).at(-1) ?? null;
  const first = current.filter(isWorking).filter((item) => item !== waiting).at(-1) ?? null;
  // Ended without an answer: the line of the latest run stays until it is dismissed. An answer shows as a card instead, and an older run's line never comes back.
  const newest = mine[0];
  const ended = newest && !newest.shownAt && !newest.dismissedAt && !isWorking(newest) && !newest.answer
    && (seen.has(newest.id) || readAt - Date.parse(newest.completedAt ?? newest.createdAt) < 3600_000) ? newest : null;
  const answered = current.filter((item) => !!item.answer && !isWorking(item));
  // An answer of a space shows once its changes are read: until then its line stays as it was, so it does not vanish a moment before the card.
  const awaiting = answered.find((item) => item.projectId !== null && !(item.id in changed));
  const run = enabled ? active ?? first ?? ended ?? (awaiting ? { ...awaiting, status: 'dispatching' as const, answer: null } : null) : ended?.endReason === 'ai_off' ? ended : null;
  const toRead = answered.filter((item) => item.projectId !== null && !(item.id in changed)).map((item) => item.id).join(',');
  useEffect(() => {
    if (!toRead) return;
    for (const id of toRead.split(',')) readRunChanges(id).catch(() => [] as AssistantChange[]).then((items) => setChanged((known) => ({ ...known, [id]: items })));
  }, [toRead]);
  const privateAnswers = answered.filter((item) => item.projectId === null || item.id in changed).reverse();

  return {
    // Masked while AI is off: a run, a suggestion or a status read before the flip is not shown.
    status: enabled ? status : null, answers,
    run, queued: enabled ? waiting : null, privateAnswers, changesOf: (runId: string) => changed[runId] ?? [], tick, refreshStatus,
    async cancelQueued() {
      if (!waiting) return;
      await stopRun(waiting.id);
      await refreshRuns();
    },
    async stopBehind() {
      if (!waiting?.behind) return;
      await stopRun(waiting.behind.runId);
      await refreshRuns();
    },
    async ask(prompt, options = {}) {
      if (!place) throw new Error('No place to ask in');
      const accepted = await askAssistant(place, {
        clientRunId: options.clientRunId ?? crypto.randomUUID(), kind: options.kind ?? 'ask', prompt,
        ...(options.continuesRunId ? { continuesRunId: options.continuesRunId } : {}),
      });
      started.current.set(accepted.id, { run: accepted, at: Date.now() });
      see([accepted.id]);
      setMine((items) => [accepted, ...items.filter((item) => item.id !== accepted.id)]);
      if (place.kind === 'space' && place.conversationId) rememberAskedConversation(meId, place.projectId, place.conversationId);
      return accepted;
    },
    async stop() {
      if (!run) return;
      await stopRun(run.id);
      await refreshRuns();
    },
    async retry(runId) {
      await retryRun(runId, crypto.randomUUID());
      await refreshRuns();
    },
    dismissRun() {
      const ending = run;
      if (!ending) return;
      setMine((items) => items.map((item) => (item.id === ending.id ? { ...item, dismissedAt: new Date().toISOString() } : item)));
      void dismissAnswer(ending.id).catch(() => { void refreshRuns(); });
    },
    async dismissPrivate(answered) {
      await dismissAnswer(answered.id);
      setMine((items) => items.map((item) => (item.id === answered.id ? { ...item, dismissedAt: new Date().toISOString() } : item)));
    },
    async show(answered) {
      const result = await showAnswer(answered.id);
      setMine((items) => items.map((item) => (item.id === answered.id ? result.run : item)));
      onShown?.(result.messageId);
      return result.messageId;
    },
  };
}
