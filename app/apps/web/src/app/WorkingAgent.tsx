import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AssistantRun } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { listOwnRuns, stopRun } from '../assistant/api';
import { isWorking } from '../assistant/format';
import { Kreska, type KreskaExpression } from '../ui';
import { useShellData } from './data';

const POLL_WHILE_WORKING_MS = 3000;

/** The person's own run that is working now, if any; refreshed by the stream and while one works. */
function useWorkingRun(identity: string) {
  const [run, setRun] = useState<AssistantRun | null>(null);
  const refresh = useCallback(() => {
    void listOwnRuns().then((page) => setRun(page.items.find(isWorking) ?? null), () => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh, identity]);
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
  return { run, refresh, setRun };
}

const face = (run: AssistantRun): KreskaExpression =>
  run.stopRequested ? 'idle' : run.status === 'queued' ? 'waiting' : run.status === 'reading' ? 'reading' : 'thinking';

const doing = (run: AssistantRun) =>
  run.stopRequested ? 'stopping…' : run.status === 'queued' ? 'getting ready' : run.status === 'reading' ? 'reading the conversation' : 'writing an answer';

/**
 * A working agent is always visible, with Stop (F-026 S13): this card in the sidebar, only while a real
 * run executes, so it never claims activity that is not happening. Stop ends it through the run's own
 * stop command. External agents' Stop joins it with #347.
 */
export function WorkingAgent({ compact = false }: { compact?: boolean }) {
  const { me } = useShellData();
  const { run, refresh, setRun } = useWorkingRun(me.user.id);
  const [stopping, setStopping] = useState(false);
  if (!run) return null;
  const stop = async () => {
    setStopping(true);
    try { setRun(await stopRun(run.id)); } catch { /* the next refresh shows the truth */ } finally { setStopping(false); refresh(); }
  };
  const label = `Your assistant is ${doing(run)}`;
  if (compact) {
    return (
      <Link className="agentlive agentlive--compact" to={`/projects/${run.projectId}/conversations/${run.conversationId}`} title={label} aria-label={label}>
        <Kreska size={24} expression={face(run)} />
      </Link>
    );
  }
  return (
    <div className="agentlive" role="status" aria-label={label}>
      <Kreska size={24} expression={face(run)} />
      <Link className="agentlive__text" to={`/projects/${run.projectId}/conversations/${run.conversationId}`}>
        <b>Your assistant</b>
        <span>{doing(run)}</span>
      </Link>
      {!run.stopRequested ? (
        <button type="button" className="agentlive__stop" aria-label="Stop your assistant" disabled={stopping} onClick={() => void stop()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
        </button>
      ) : null}
    </div>
  );
}
