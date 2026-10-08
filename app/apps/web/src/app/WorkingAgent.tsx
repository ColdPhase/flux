import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { AssistantRun, OwnWorkingAgent } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { listOwnRuns, stopRun } from '../assistant/api';
import { isWorking } from '../assistant/format';
import { Icon, Kreska, agentHue, useToast, type KreskaExpression } from '../ui';
import { getOwnWorkingAgents } from '../agents/api';
import { stopFailure, stopAgentWork } from '../agents/stop';
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
  const dismissFailure = useCallback(() => {
    setSnapshot((previous) => previous.identity === identity ? { ...previous, failed: false } : previous);
  }, [identity]);
  return { run, stop, dismissFailure, stopping: snapshot.identity === identity && snapshot.stopping, failed: snapshot.identity === identity && snapshot.failed };
}

const face = (run: AssistantRun): KreskaExpression =>
  run.stopRequested ? 'idle' : run.status === 'queued' ? 'waiting' : run.status === 'reading' ? 'reading' : 'thinking';

const doing = (run: AssistantRun) =>
  run.stopRequested ? 'stopping…' : run.status === 'queued' ? 'getting ready' : run.status === 'reading' ? 'reading the conversation' : 'writing an answer';

/** The person's own external agents that work on a task now. Reads on mount, focus, every event and a slow timer. */
function useOwnWorkingAgents(identity: string) {
  const [state, setState] = useState<{ identity: string; items: OwnWorkingAgent[] }>({ identity, items: [] });
  const reload = useRef<() => void>(() => { /* not mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getOwnWorkingAgents(current.signal).then((read) => { if (!current.signal.aborted) setState({ identity, items: read.items }); },
        () => { /* keep what is shown; the next trigger retries */ });
    };
    reload.current();
    const onFocus = () => reload.current();
    const timer = window.setInterval(onFocus, 20_000);
    window.addEventListener('focus', onFocus);
    return () => { controller?.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus); reload.current = () => { /* unmounted */ }; };
  }, [identity]);
  useStreamEvents(identity, () => reload.current(), () => reload.current());
  return { items: state.identity === identity ? state.items : [], reload: useCallback(() => reload.current(), []) };
}

/**
 * A working agent is always visible with Stop (S13): the person's own external agent, with the task it works on. Stop is the
 * project's own command (`POST agent-stops`); the card goes away when the read after it no longer finds the agent working.
 */
function OwnAgentCard({ item, compact, onChanged }: { item: OwnWorkingAgent; compact: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const label = `${item.agent.name} is working on #${item.task.number}`;
  const destination = `/projects/${item.task.projectId}/agents`;
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await stopAgentWork(item.task.projectId, item.agent.id, item.task);
      toast({ message: `Stopped ${item.agent.name} on #${item.task.number}`, tone: 'success' });
    } catch (cause) {
      toast({ message: stopFailure(cause), tone: 'danger' });
    } finally { setStopping(false); onChanged(); }
  };
  const hue = agentHue(item.agent.id);
  return (
    <div className={`agentlive agentlive--agent${compact ? ' agentlive--compact' : ''}`} role="status" aria-label={label} data-agent={item.agent.id}>
      {compact ? (
        <Link className="agentlive__link" to={destination} title={label} aria-label={label}><Kreska size={24} expression="thinking" hue={hue} /></Link>
      ) : (
        <>
          <Kreska size={24} expression="thinking" hue={hue} />
          <Link className="agentlive__text" to={destination}>
            <b>{item.agent.name}</b>
            <span>{stopping ? 'Stopping…' : `#${item.task.number} · ${item.task.title}`}</span>
          </Link>
        </>
      )}
      <button type="button" className="agentlive__stop" aria-label={`Stop ${item.agent.name}`} title={stopping ? 'Stopping…' : `Stop ${item.agent.name}`}
        disabled={stopping} onClick={() => void stop()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
      </button>
    </div>
  );
}

/** The working-agent card(s): the person's own assistant (its own Stop) and their own external agents that work on a task. */
export function WorkingAgent({ compact = false }: { compact?: boolean }) {
  const { me } = useShellData();
  const agents = useOwnWorkingAgents(me.user.id);
  // Several agents at once: the card shows the first with how many more work, so the sidebar never grows.
  const first = agents.items[0];
  return (
    <>
      <WorkingAssistant compact={compact} />
      {first ? (
        <>
          <OwnAgentCard item={first} compact={compact} onChanged={agents.reload} />
          {agents.items.length > 1 && !compact ? <p className="agentlive__more">+{agents.items.length - 1} more working</p> : null}
        </>
      ) : null}
    </>
  );
}

/** Own-assistant Stop uses its existing permission-backed command. */
function WorkingAssistant({ compact = false }: { compact?: boolean }) {
  const { me } = useShellData();
  const { run, stop, dismissFailure, stopping, failed } = useWorkingRun(me.user.id);
  const stopButton = useRef<HTMLButtonElement>(null);
  if (!run) return null;
  const label = stopping ? 'Stopping your assistant…' : `Your assistant is ${doing(run)}`;
  const destination = `/projects/${run.projectId}/conversations/${run.conversationId}`;
  return (
    <>
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
      <button ref={stopButton} type="button" className="agentlive__stop" aria-label="Stop your assistant" title={stopping || run.stopRequested ? 'Stopping…' : 'Stop your assistant'}
        disabled={stopping || run.stopRequested} onClick={() => void stop()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
      </button>
      {failed && !compact ? <span className="agentlive__error" role="alert">Couldn’t stop your assistant. Try again.</span> : null}
    </div>
    {failed && compact ? createPortal(
      <div className="ui-toasts agentlive__notices">
        <div className="ui-toast ui-toast--danger agentlive__notice" role="alert">
          <Icon name="alert" />
          <span className="ui-toast__msg">Couldn’t stop your assistant. Try again.</span>
          <button type="button" className="ui-toast__close" aria-label="Dismiss Stop error" onClick={() => { dismissFailure(); stopButton.current?.focus(); }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>, document.body,
    ) : null}
    </>
  );
}
