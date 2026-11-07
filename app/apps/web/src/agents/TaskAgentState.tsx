import { useCallback, useEffect, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type TaskAgentLine, type TaskAgentState as State, type WorkItem } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { AgentIdentity, Button, Kreska, type KreskaExpression } from '../ui';
import { useShellData } from '../app/data';
import { getWork, updateWork } from '../work/api';
import { useAssistantChanges, WaitingChanges } from '../assistant/WaitingChanges';
import { getTaskAgentState, retryTaskAgent, stopTaskAgent } from './taskAgents';
import './task-agent.css';

// The agent on a task, in one plain line (#856, F-036 AG-5; mockup AgentStates). It is the same line for everyone who reads the
// task. Stop is the agent's owner's or a space admin's; Try again and Take it back are the owner's. What the agent changed carries
// Undo and what waits for the owner's OK waits here too, as in every agent message.

const FACE: Record<TaskAgentLine, KreskaExpression> = {
  waiting_for_room: 'waiting', working: 'working', waiting_for_ok: 'asking', paused_by_limit: 'asleep', failed: 'worried', stopped: 'idle', done: 'done', handed_back: 'idle',
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function TaskAgentState({ item, projectId, conversationId, revision, onChanged }: {
  item: Pick<WorkItem, 'id' | 'version'>; projectId: string; conversationId: string | null; revision: unknown; onChanged: () => void;
}) {
  const { me } = useShellData();
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getTaskAgentState(item.id, controller.signal).then(setState, () => { if (!controller.signal.aborted) setState(null); });
    return () => controller.abort();
  }, [item.id, revision, tick]);
  // The run and the task change on the server, not here: a run's progress reaches its owner, the task's changes everyone.
  useStreamEvents(me.user.id, (event) => {
    if (event.kind === ASSISTANT_RUN_CHANGED_EVENT || (event.objectType === 'project' && event.objectId === projectId && /^project\.(work_|message_|assistant_)/.test(event.kind))) setTick((value) => value + 1);
  }, () => setTick((value) => value + 1));
  const changes = useAssistantChanges(conversationId, `${state?.runId}:${tick}`, !!state?.runId);
  const runChanges = state?.runId ? changes.byRun.get(state.runId) : undefined;

  const act = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await action(); setTick((value) => value + 1); onChanged(); }
    catch (cause) { setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Couldn’t do that. Try again.'); }
    finally { setBusy(''); }
  }, [onChanged]);

  if (!state?.line || !state.agent) return runChanges ? <div className="wd-agent"><WaitingChanges changes={runChanges} onChanged={changes.refresh} meId={me.user.id} standalone /></div> : null;
  // At the version it has now: the agent's own finishing may have moved it since this panel was read.
  const takeBack = () => act('back', async () => updateWork(await getWork(item.id), { owner: { kind: 'human', id: me.user.id }, ...(state.line === 'done' ? { status: 'in_progress' as const } : {}) }, crypto.randomUUID()));
  // Back with you to check (mockup AgentStates 8): the owner closes it from the line once it is checked.
  const markDone = () => act('done', async () => updateWork(await getWork(item.id), { status: 'done' }, crypto.randomUUID()));
  return (
    <div className="wd-agent" data-agent-line={state.line}>
      <div className="wd-agent__line" role="status" aria-live="polite">
        <Kreska size={20} expression={FACE[state.line]} />
        <AgentIdentity name={state.agent.name} owner={state.agent.owner.id === me.user.id ? 'you' : state.agent.owner.name} icon={false} />
        <span className="wd-agent__text">{state.text}{state.resumesAt ? `, resumes at ${clock(state.resumesAt)}` : ''}</span>
        <span className="wd-agent__actions">
          {state.canStop ? <Button variant="secondary" size="sm" busy={busy === 'stop'} onClick={() => void act('stop', () => stopTaskAgent(item.id))}>Stop</Button> : null}
          {state.canTryAgain ? <Button variant="secondary" size="sm" busy={busy === 'retry'} onClick={() => void act('retry', () => retryTaskAgent(item.id))}>Try again</Button> : null}
          {state.canMarkDone ? <Button variant="secondary" size="sm" busy={busy === 'done'} onClick={() => void markDone()}>Mark done</Button> : null}
          {state.canTakeBack ? <Button variant="quiet" size="sm" busy={busy === 'back'} onClick={() => void takeBack()}>{state.line === 'done' ? 'Undo' : 'Take it back'}</Button> : null}
        </span>
      </div>
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      {runChanges ? <WaitingChanges changes={runChanges} onChanged={changes.refresh} meId={me.user.id} standalone /> : null}
    </div>
  );
}
