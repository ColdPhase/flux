import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentQuestion } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { getAgentQuestions } from './api';

/**
 * Agents' questions of the projects being read (S14, #347), by the message that carries each. One store per project, so
 * the cards of a long conversation share one read; `useProjectQuestions` (once per view) keeps it current.
 */
interface Store { questions: Map<string, AgentQuestion>; listeners: Set<() => void>; version: number }
const stores = new Map<string, Store>();
const reload = new Map<string, () => Promise<void>>();
const store = (projectId: string): Store => {
  let found = stores.get(projectId);
  if (!found) { found = { questions: new Map(), listeners: new Set(), version: 0 }; stores.set(projectId, found); }
  return found;
};
const publish = (projectId: string, next: Map<string, AgentQuestion>) => {
  const current = store(projectId);
  current.questions = next;
  current.version++;
  for (const listener of current.listeners) listener();
};

/** A question as the server last stored it (an answer this person just gave, or a fresh read). */
export function rememberQuestion(question: AgentQuestion) {
  publish(question.projectId, new Map(store(question.projectId).questions).set(question.messageId, question));
}

/** The question carried by this message, if any; null for every ordinary message. */
export function useQuestion(projectId: string, messageId: string): AgentQuestion | null {
  const current = store(projectId);
  useSyncExternalStore(
    (listener) => { current.listeners.add(listener); return () => { current.listeners.delete(listener); }; },
    () => current.version,
  );
  return current.questions.get(messageId) ?? null;
}

/** Every question of the project as the store holds it now (newest first); the list is current on each change. */
export function useQuestionList(projectId: string): AgentQuestion[] {
  const current = store(projectId);
  const version = useSyncExternalStore(
    (listener) => { current.listeners.add(listener); return () => { current.listeners.delete(listener); }; },
    () => current.version,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the list is rebuilt per store version
  return useMemo(() => [...current.questions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [current, version]);
}

/** Reads the project's questions now, on a question event, on focus and on a resync; a failed read keeps what is shown. */
export function useProjectQuestions(projectId: string, meId: string) {
  useEffect(() => {
    const controller = new AbortController();
    const load = () => getAgentQuestions(projectId, controller.signal).then((read) => {
      if (!controller.signal.aborted) publish(projectId, new Map(read.questions.map((question) => [question.messageId, question])));
    }, () => { /* keep the last read */ });
    void load();
    window.addEventListener('focus', load);
    reload.set(projectId, load);
    return () => { controller.abort(); window.removeEventListener('focus', load); reload.delete(projectId); };
  }, [projectId]);
  useStreamEvents(meId, (event) => {
    if (event.objectId === projectId && (event.kind === 'project.question_asked.v1' || event.kind === 'project.question_answered.v1')) void reload.get(projectId)?.();
  }, () => { void reload.get(projectId)?.(); });
}
