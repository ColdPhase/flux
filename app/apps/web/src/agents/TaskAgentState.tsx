import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_RUN_CHANGED_EVENT, type AssistantChange, type TaskAgentLine, type TaskAgentState as State, type WorkItem } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { AgentIdentity, Button, Kreska, type KreskaExpression } from '../ui';
import { useShellData } from '../app/data';
import { getWork, updateWork } from '../work/api';
import { useAssistantChanges, WaitingChanges } from '../assistant/WaitingChanges';
import { useAgentHue } from './hues';
import { getTaskAgentState, retryTaskAgent, stopTaskAgent } from './taskAgents';
import './task-agent.css';

// The agent on a task, in one plain line (#856, F-036 AG-5; mockup AgentStates). It is the same line for everyone who reads the
// task. Stop is the agent's owner's or a space admin's; Try again and Take it back are the owner's. What the agent changed carries
// Undo and what waits for the owner's OK waits here too, as in every agent message.

const FACE: Record<TaskAgentLine, KreskaExpression> = {
  waiting_for_room: 'waiting', working: 'working', waiting_for_ok: 'asking', paused_by_limit: 'asleep', failed: 'worried', stopped: 'idle', done: 'done', handed_back: 'idle',
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * An agent's task that is done (personas-26, #856): the task's history line says it for every reader, so no state line is drawn for it. The
 * history line names this agent's change and carries `undo` for the agent's owner alone (null for anyone else).
 */
export interface AgentDone { agentId: string; undo: (() => void) | null; busy: boolean }

export function TaskAgentState({ item, projectId, conversationId, revision, onChanged, elsewhere, onDone }: {
  item: Pick<WorkItem, 'id' | 'version'>; projectId: string; conversationId: string | null; revision: unknown; onChanged: () => void;
  /** A change that is shown where it stands (an agent's line in the thread, with its own Undo), not in the run's line. */
  elsewhere?: (change: AssistantChange) => boolean;
  /** Told when the agent's task is done, or no longer: the history line says it, with the owner's Undo. */
  onDone?: (done: AgentDone | null) => void;
}) {
  const { me } = useShellData();
  const hue = useAgentHue();
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
  const here = state?.runId ? changes.byRun.get(state.runId)?.filter((change) => !elsewhere?.(change)) : undefined;
  const runChanges = here?.length ? here : undefined;
  // An Approve or Skip may end the wait: the line above the cards ("Waiting for your OK") is read again with them, not at the next reload.
  const refreshChanges = changes.refresh;
  const decided = useCallback(async () => { setTick((value) => value + 1); await refreshChanges(); }, [refreshChanges]);

  const act = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await action(); setTick((value) => value + 1); onChanged(); }
    catch (cause) { setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Couldn’t do that. Try again.'); }
    finally { setBusy(''); }
  }, [onChanged]);

  // At the version it has now: the agent's own finishing may have moved it since this panel was read.
  const takeBack = () => act('back', async () => updateWork(await getWork(item.id), { owner: { kind: 'human', id: me.user.id }, ...(state?.line === 'done' ? { status: 'in_progress' as const } : {}) }, crypto.randomUUID()));
  const back = useRef(takeBack);
  useEffect(() => { back.current = takeBack; });
  const undoDone = useCallback(() => { void back.current(); }, []);
  const doneAgent = state?.line === 'done' && state.agent ? state.agent.id : null;
  const doneUndo = !!doneAgent && !!state?.canTakeBack;
  useEffect(() => { onDone?.(doneAgent ? { agentId: doneAgent, undo: doneUndo ? undoDone : null, busy: busy === 'back' } : null); }, [onDone, doneAgent, doneUndo, undoDone, busy]);
  useEffect(() => () => onDone?.(null), [onDone]);

  // Done is said once, by the task's history line (personas-26, #856): no state line for it.
  if (!state?.line || !state.agent || state.line === 'done') {
    return runChanges || error ? <div className="wd-agent">{error ? <p className="wd-error" role="alert">{error}</p> : null}
      {runChanges ? <WaitingChanges changes={runChanges} onChanged={decided} meId={me.user.id} standalone /> : null}</div> : null;
  }
  // Back with you to check (mockup AgentStates 8): the owner closes it from the line once it is checked.
  const markDone = () => act('done', async () => updateWork(await getWork(item.id), { status: 'done' }, crypto.randomUUID()));
  return (
    <div className="wd-agent" data-agent-line={state.line}>
      <div className="wd-agent__line" role="status" aria-live="polite">
        <Kreska size={20} expression={FACE[state.line]} hue={hue(state.agent)} />
        <AgentIdentity name={state.agent.name} owner={state.agent.owner.name} icon={false} />
        <span className="wd-agent__text">{state.budget && state.resumesAt
          // The key's budget (train 37 rows 36-37): when it starts again, and for its owner where the budget is raised.
          ? `${state.text}. It starts again at ${clock(state.resumesAt)}${state.agent.owner.id === me.user.id ? ', or raise the budget in Settings › AI' : ''}.`
          : `${state.text}${state.resumesAt ? `, resumes at ${clock(state.resumesAt)}` : ''}`}</span>
        <span className="wd-agent__actions">
          {state.canStop ? <Button variant="secondary" size="sm" busy={busy === 'stop'} onClick={() => void act('stop', () => stopTaskAgent(item.id))}>Stop</Button> : null}
          {state.canTryAgain ? <Button variant="secondary" size="sm" busy={busy === 'retry'} onClick={() => void act('retry', () => retryTaskAgent(item.id))}>Try again</Button> : null}
          {state.canMarkDone ? <Button variant="secondary" size="sm" busy={busy === 'done'} onClick={() => void markDone()}>Mark done</Button> : null}
          {state.canTakeBack ? <Button variant="quiet" size="sm" busy={busy === 'back'} onClick={() => void takeBack()}>Take it back</Button> : null}
        </span>
      </div>
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      {runChanges ? <WaitingChanges changes={runChanges} onChanged={decided} meId={me.user.id} standalone /> : null}
    </div>
  );
}
