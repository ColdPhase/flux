import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { ASSISTANT_RUN_CHANGED_EVENT, type AssistantRun, type OwnWorkingAgent } from '@flux/contracts';
import { onPageLive, pageLeaving } from '../api/pageLeaving';
import { useStreamEvents } from '../api/stream';
import { listOwnRuns, stopRun } from '../assistant/api';
import { isWorking } from '../assistant/format';
import { Icon, Kreska, agentHue, useToast, type KreskaExpression } from '../ui';
import { useSmallMoments } from './smallMoments';
import { getOwnWorkingAgents } from '../agents/api';
import { stopFailure, stopAgentWork } from '../agents/stop';
import { useShellData } from './data';
import { RefLink } from '../place/origin';
import { useAllAiBlocked, useProjectAiBlocked } from '../ai/workspaceAi';

const POLL_WHILE_WORKING_MS = 3000;
interface WorkingSnapshot { identity: string; run: AssistantRun | null; stopping: boolean; failed: boolean }
interface WorkingLifetime { identity: string; live: boolean; revision: number; read: AbortController | null; stopping: boolean }

/** Reads and Stop share one owner/lifetime fence; neither may restore an older working answer. */
function useWorkingRun(identity: string) {
  // F-029 (#614): with AI off in every workspace there is nothing of the assistant's to read.
  const allOff = useAllAiBlocked();
  const [snapshot, setSnapshot] = useState<WorkingSnapshot>({ identity, run: null, stopping: false, failed: false });
  const lifetime = useRef<WorkingLifetime | null>(null);
  // Background reads (poll, focus, stream) wait while this page is hidden or being left (see
  // pageLeaving, #471). User-started requests never go through refresh().
  const refresh = useCallback(() => {
    const scope = lifetime.current;
    if (allOff || !scope?.live || scope.identity !== identity || scope.stopping) return;
    if (pageLeaving() || document.visibilityState === 'hidden') return;
    scope.read?.abort();
    const controller = new AbortController();
    scope.read = controller;
    const revision = ++scope.revision;
    const current = () => scope.live && lifetime.current === scope && revision === scope.revision && !controller.signal.aborted;
    void listOwnRuns(controller.signal).then((page) => {
      if (!current()) return;
      const run = page.items.find((item) => isWorking(item) && item.status !== 'queued') ?? page.items.find(isWorking) ?? null;
      setSnapshot((previous) => ({ identity, run, stopping: false,
        failed: previous.identity === identity && previous.run?.id === run?.id && previous.failed }));
    }, () => {
      if (current()) setSnapshot({ identity, run: null, stopping: false, failed: false });
    });
  }, [identity, allOff]);
  useEffect(() => {
    const scope: WorkingLifetime = { identity, live: true, revision: 0, read: null, stopping: false };
    lifetime.current = scope;
    const retire = () => {
      scope.live = false;
      ++scope.revision;
      scope.read?.abort();
      scope.read = null;
    };
    const resume = () => {
      if (lifetime.current !== scope || scope.live) return;
      scope.live = true;
      // A Stop response from the retired lifetime stays fenced. Read current truth;
      // resuming never resends the command or revives its pre-Stop snapshot.
      scope.stopping = false;
      refresh();
    };
    const focus = () => { if (scope.live) refresh(); else resume(); };
    window.addEventListener('beforeunload', retire);
    window.addEventListener('pagehide', retire);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', focus);
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    refresh();
    return () => {
      window.removeEventListener('beforeunload', retire);
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      retire();
      if (lifetime.current === scope) lifetime.current = null;
    };
  }, [identity, refresh]);
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    // A read skipped while the page was being left runs again once it is live.
    const stopWaiting = onPageLive(refresh);
    return () => {
      stopWaiting();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh]);
  // The previous owner's snapshot is hidden immediately, before effect cleanup runs.
  const run = snapshot.identity === identity ? snapshot.run : null;
  useEffect(() => {
    if (!run) return undefined;
    const timer = setInterval(refresh, POLL_WHILE_WORKING_MS);
    return () => clearInterval(timer);
  }, [run, refresh]);
  useStreamEvents(identity, (event) => { if (event.kind === ASSISTANT_RUN_CHANGED_EVENT) refresh(); }, refresh);
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
  run.stopRequested ? 'stopping…' : run.status === 'queued' ? 'getting ready'
    // F-027 AST-10: the owner's own Claude Code reads for itself; one plain word while it works.
    : run.engine === 'runtime' ? 'working…' : run.status === 'reading' ? 'reading the conversation' : 'writing an answer';

/** The person's own external agents that work on a task now. Reads on mount, focus, every event and a slow timer. */
function useOwnWorkingAgents(identity: string) {
  const allOff = useAllAiBlocked();
  const [state, setState] = useState<{ identity: string; items: OwnWorkingAgent[] }>({ identity, items: [] });
  const reload = useRef<() => void>(() => { /* not mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    if (allOff) return undefined;
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
  }, [identity, allOff]);
  useStreamEvents(identity, () => reload.current(), () => reload.current());
  return { items: state.identity === identity ? state.items : [], reload: useCallback(() => reload.current(), []) };
}

/**
 * A working agent is always visible with Stop (S13): the person's own external agent, with the task it works on. Stop is the
 * project's own command (`POST agent-stops`); the card goes away when the read after it no longer finds the agent working.
 */
/** Stops one own external agent on its task; the shared path for the sidebar card, Home and the phone conversation header. */
function useStopOwnAgent(item: OwnWorkingAgent, onChanged: () => void) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
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
  return { stopping, stop };
}

function OwnAgentCard({ item, compact, onChanged }: { item: OwnWorkingAgent; compact: boolean; onChanged: () => void }) {
  const { stopping, stop } = useStopOwnAgent(item, onChanged);
  // A live session alone is not work: C-1 requires the current task's live claimed unit.
  const label = item.working ? `${item.agent.name} is working on #${item.task.number}` : `${item.agent.name} · handed #${item.task.number}`;
  const expression: KreskaExpression = item.working ? 'working' : item.online ? 'idle' : 'asleep';
  const taskLabel = item.working ? `#${item.task.number} · ${item.task.title}`
    : `Handed #${item.task.number}${item.online ? '' : ` · ${item.signedIn ? 'offline' : 'not signed in yet'}`}`;
  const destination = `/projects/${item.task.projectId}/agents`;
  const hue = agentHue(item.agent.id);
  return (
    <div className={`agentlive agentlive--agent${compact ? ' agentlive--compact' : ''}`} role="status" aria-label={label} data-agent={item.agent.id} data-ai-surface="working-agent">
      {compact ? (
        <RefLink className="agentlive__link" to={destination} title={label} aria-label={label}><Kreska size={24} expression={expression} hue={hue} /></RefLink>
      ) : (
        <>
          <Kreska size={24} expression={expression} hue={hue} />
          <RefLink className="agentlive__text" to={destination}>
            <b>{item.agent.name}</b>
            <span>{stopping ? 'Stopping…' : taskLabel}</span>
          </RefLink>
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
  const aiOff = useProjectAiBlocked();
  // Home lists every working agent itself (HomeWorkingAgents), so the sidebar card steps aside there.
  const onHome = useLocation().pathname === '/';
  // Agents of a workspace whose AI is off (#614) are not shown. Several at once: online ones first; the card shows the first with how many more are online, so the sidebar never grows.
  const items = agents.items.filter((item) => !aiOff(item.task.projectId));
  const ordered = [...items.filter((item) => item.working), ...items.filter((item) => !item.working)];
  const first = ordered[0];
  const workingCount = items.filter((item) => item.working).length;
  return (
    <>
      <WorkingAssistant compact={compact} />
      {first && !onHome ? (
        <>
          <OwnAgentCard item={first} compact={compact} onChanged={agents.reload} />
          {workingCount > 1 && !compact ? <p className="agentlive__more">+{workingCount - 1} more working</p> : null}
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
  const moments = useSmallMoments();
  const aiOff = useProjectAiBlocked();
  if (!run || aiOff(run.projectId)) return null;
  const label = stopping ? 'Stopping your assistant…' : `Your assistant is ${doing(run)}`;
  const destination = `/projects/${run.projectId}/conversations/${run.conversationId}`;
  return (
    <>
    <div className={`agentlive${compact ? ' agentlive--compact' : ''}`} role="status" aria-label={label} data-ai-surface="working-assistant">
      {compact ? (
        <RefLink className="agentlive__link" to={destination} title={label} aria-label={label}>
          {moments ? <Kreska size={24} expression={face(run)} /> : <span className="agentlive__mark" aria-hidden="true"><Icon name="spark" size={20} /></span>}
        </RefLink>
      ) : (
        <>
          {moments ? <Kreska size={24} expression={face(run)} /> : <span className="agentlive__mark" aria-hidden="true"><Icon name="spark" size={20} /></span>}
          <RefLink className="agentlive__text" to={destination}>
            <b>Your assistant</b>
            <span>{stopping ? 'requesting Stop…' : doing(run)}</span>
          </RefLink>
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

/** Home's own list of the person's working external agents, each with Stop (S13), so Home shows them at every width. */
export function HomeWorkingAgents() {
  const { me } = useShellData();
  const agents = useOwnWorkingAgents(me.user.id);
  const aiOff = useProjectAiBlocked();
  const items = agents.items.filter((item) => !aiOff(item.task.projectId));
  if (!items.length) return null;
  return (
    <section className="home-agents" aria-label="Your agents working now" data-ai-surface="home-working-agents">
      {items.map((item) => <OwnAgentCard key={item.task.id} item={item} compact={false} onChanged={agents.reload} />)}
    </section>
  );
}

/** The phone conversation header's Stop (S13): the person's own external agent that works in this project, if one does. */
export function ProjectAgentStop({ projectId }: { projectId: string }) {
  const { me } = useShellData();
  const agents = useOwnWorkingAgents(me.user.id);
  const aiOff = useProjectAiBlocked();
  const item = aiOff(projectId) ? undefined : agents.items.find((candidate) => candidate.task.projectId === projectId);
  return item ? <HeaderAgentStop item={item} onChanged={agents.reload} /> : null;
}

function HeaderAgentStop({ item, onChanged }: { item: OwnWorkingAgent; onChanged: () => void }) {
  const { stopping, stop } = useStopOwnAgent(item, onChanged);
  const label = `Stop ${item.agent.name}`;
  return (
    <button type="button" className="agentlive__stop" aria-label={label} title={stopping ? 'Stopping…' : label}
      disabled={stopping} onClick={() => void stop()}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
    </button>
  );
}
