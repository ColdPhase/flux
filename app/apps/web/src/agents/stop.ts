import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStop } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useToast } from '../ui';
import { getAgentStops, stopAgent } from './api';

/** What a person is told when Stop did not happen; nothing changed in any of these. */
export function stopFailure(cause: unknown): string {
  if (cause instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (cause instanceof ApiError) {
    if (cause.code === 'AGENT_NOT_WORKING') return 'That agent was not working on this task any more.';
    if (cause.code === 'STOP_NOT_ALLOWED') return 'Only a project manager, the agent’s owner or the task’s creator can stop it.';
    if (cause.status === 403 || cause.status === 404) return 'You can’t stop this agent here.';
  }
  return 'That didn’t work. Nothing changed; try again.';
}

/**
 * Stop for an external agent's work on one task (S13). One request at a time per agent and task; a retry after a lost
 * answer repeats its key, so the stop happens once. `onSettled` refetches whatever shows the work.
 */
export function useStopAgent(projectId: string, onSettled: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const attempts = useRef(new Map<string, string>());
  const stop = useCallback(async (agentId: string, task: { id: string; number: number }) => {
    const key = `${agentId}:${task.id}`;
    if (busy) return;
    if (!attempts.current.has(key)) attempts.current.set(key, crypto.randomUUID());
    setBusy(key);
    try {
      await stopAgent(projectId, { agentId, taskId: task.id }, attempts.current.get(key)!);
      attempts.current.delete(key);
      toast({ message: `Stopped work on #${task.number}`, tone: 'success' });
    } catch (cause) {
      if (cause instanceof ApiError) attempts.current.delete(key);
      toast({ message: stopFailure(cause), tone: 'danger' });
    } finally {
      setBusy(null);
      onSettled();
    }
  }, [busy, projectId, toast, onSettled]);
  return { stop, busy };
}

/**
 * Who stopped which agent's work here, newest first. Refetched when a stop happens anywhere (the event), on focus and
 * after this person's own Stop; a failed read keeps what is shown.
 */
export function useAgentStops(projectId: string, meId: string) {
  const [stops, setStops] = useState<AgentStop[]>([]);
  const reload = useRef<() => void>(() => { /* not mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getAgentStops(projectId, current.signal).then((read) => { if (!current.signal.aborted) setStops(read.stops); }, () => { /* keep the last list */ });
    };
    reload.current();
    const onFocus = () => reload.current();
    window.addEventListener('focus', onFocus);
    return () => { controller?.abort(); window.removeEventListener('focus', onFocus); reload.current = () => { /* unmounted */ }; };
  }, [projectId]);
  useStreamEvents(meId, (event) => {
    if (event.kind === 'project.agent_stopped.v1' && event.objectId === projectId) reload.current();
  }, () => reload.current());
  return { stops, reload: useCallback(() => reload.current(), []) };
}

/** One Stop request with its own key per call; the sidebar card has no retry state of its own. */
export const stopAgentWork = (projectId: string, agentId: string, task: { id: string }) =>
  stopAgent(projectId, { agentId, taskId: task.id }, crypto.randomUUID());
