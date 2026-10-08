import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AssistantRun } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { listOwnRuns, stopRun } from '../assistant/api';
import { isWorking } from '../assistant/format';
import { Kreska, type KreskaExpression } from '../ui';
import { useShellData } from './data';

const POLL_WHILE_WORKING_MS = 3000;
interface WorkingSnapshot { identity: string; run: AssistantRun | null; stopping: boolean; failed: boolean }
interface WorkingLifetime { identity: string; live: boolean; revision: number; read: AbortController | null; stopping: boolean }

/** Reads and Stop share one owner/lifetime fence; neither may restore an older working answer. */
function useWorkingRun(identity: string) {
  const [snapshot, setSnapshot] = useState<WorkingSnapshot>({ identity, run: null, stopping: false, failed: false });
  const lifetime = useRef<WorkingLifetime | null>(null);
  const refresh = useCallback(() => {
    const scope = lifetime.current;
    if (!scope?.live || scope.identity !== identity || scope.stopping) return;
    scope.read?.abort();
    const controller = new AbortController();
    scope.read = controller;
    const revision = ++scope.revision;
    const current = () => scope.live && lifetime.current === scope && revision === scope.revision && !controller.signal.aborted;
    void listOwnRuns(controller.signal).then((page) => {
      if (!current()) return;
      const run = page.items.find(isWorking) ?? null;
      setSnapshot((previous) => ({ identity, run, stopping: false,
        failed: previous.identity === identity && previous.run?.id === run?.id && previous.failed }));
    }, () => {
      if (current()) setSnapshot({ identity, run: null, stopping: false, failed: false });
    });
  }, [identity]);
  useEffect(() => {
    const scope: WorkingLifetime = { identity, live: true, revision: 0, read: null, stopping: false };
    lifetime.current = scope;
    refresh();
    return () => {
      scope.live = false;
      ++scope.revision;
      scope.read?.abort();
      if (lifetime.current === scope) lifetime.current = null;
    };
  }, [identity, refresh]);
  // The previous owner's snapshot is hidden immediately, before effect cleanup runs.
  const run = snapshot.identity === identity ? snapshot.run : null;
  useEffect(() => {
    if (!run) return undefined;
    const timer = setInterval(refresh, POLL_WHILE_WORKING_MS);
    return () => clearInterval(timer);
  }, [run, refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  useStreamEvents(identity, refresh, refresh);
  const stop = useCallback(async () => {
    const scope = lifetime.current;
    if (!run || !scope?.live || scope.identity !== identity || scope.stopping || run.stopRequested) return;
    scope.stopping = true;
    const revision = ++scope.revision;
    scope.read?.abort();
    setSnapshot({ identity, run, stopping: true, failed: false });
    const current = () => scope.live && lifetime.current === scope && scope.identity === identity && revision === scope.revision;
    try {
      const stopped = await stopRun(run.id);
      if (current()) setSnapshot({ identity, run: isWorking(stopped) ? stopped : null, stopping: false, failed: false });
    } catch {
      if (current()) setSnapshot({ identity, run, stopping: false, failed: true });
    } finally {
      if (current()) {
        scope.stopping = false;
        refresh();
      }
    }
  }, [identity, run, refresh]);
  return { run, stop, stopping: snapshot.identity === identity && snapshot.stopping, failed: snapshot.identity === identity && snapshot.failed };
}

const face = (run: AssistantRun): KreskaExpression =>
  run.stopRequested ? 'idle' : run.status === 'queued' ? 'waiting' : run.status === 'reading' ? 'reading' : 'thinking';

const doing = (run: AssistantRun) =>
  run.stopRequested ? 'stopping…' : run.status === 'queued' ? 'getting ready' : run.status === 'reading' ? 'reading the conversation' : 'writing an answer';

/** Own-assistant Stop uses its existing permission-backed command; external agents join in #347. */
export function WorkingAgent({ compact = false }: { compact?: boolean }) {
  const { me } = useShellData();
  const { run, stop, stopping, failed } = useWorkingRun(me.user.id);
  if (!run) return null;
  const label = stopping ? 'Stopping your assistant…' : `Your assistant is ${doing(run)}`;
  const destination = `/projects/${run.projectId}/conversations/${run.conversationId}`;
  return (
    <div className={`agentlive${compact ? ' agentlive--compact' : ''}`} role="status" aria-label={label}>
      {compact ? (
        <Link className="agentlive__link" to={destination} title={label} aria-label={label}>
          <Kreska size={24} expression={face(run)} />
        </Link>
      ) : (
        <>
          <Kreska size={24} expression={face(run)} />
          <Link className="agentlive__text" to={destination}>
            <b>Your assistant</b>
            <span>{stopping ? 'requesting Stop…' : doing(run)}</span>
          </Link>
        </>
      )}
      <button type="button" className="agentlive__stop" aria-label="Stop your assistant" title={stopping || run.stopRequested ? 'Stopping…' : 'Stop your assistant'}
        disabled={stopping || run.stopRequested} onClick={() => void stop()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
      </button>
      {failed ? <span className="agentlive__error" role="alert">{compact ? 'Stop failed' : 'Couldn’t stop your assistant. Try again.'}</span> : null}
    </div>
  );
}
