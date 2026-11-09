import { createHash } from 'node:crypto';
import type { TaskAgentLine, TaskAgentState } from '@flux/contracts';

// The rules of a person's agent working on a task (#856, F-036 AG-5), without a database: what it is told, the
// deterministic ids of its runs, and the one plain line the task panel shows (docs/design: AgentStates).

/** The task as data in the run's request: its number and title, and nothing the agent should obey. */
export function taskRunPrompt(task: { number: number; title: string }): string {
  return `Task #${task.number}: ${task.title.replace(/\s+/g, ' ').trim().slice(0, 300)}`.slice(0, 600);
}

/** What the agent says when it takes a task, before its model is called (AgentStates 1). No model call is made for it. */
export const TAKEN_WORDS = 'Got it, I\'m on it.';

/**
 * One owner assignment, one run: the same assignment event always names the same run, so a drained event that is handled twice
 * (a crash after the run was made) meets its earlier run instead of starting a second.
 */
export function taskRunClientId(eventId: string): string {
  const digits = createHash('sha256').update(`flux.agent-task.run.v1:${eventId}`).digest('hex').slice(0, 32).split('');
  digits[12] = '8';
  digits[16] = ((parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = digits.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const IN_FLIGHT = new Set(['queued', 'reading', 'dispatching']);

export interface TaskAgentFacts {
  viewerId: string;
  /** Whether the viewer is an admin of the task's space. */
  viewerIsAdmin: boolean;
  task: { ownerUserId: string | null; ownerAgentId: string | null; status: string };
  /** The agent that holds the task now, or else the one whose latest run this is. */
  agent: { id: string; name: string; owner: { id: string; name: string } } | null;
  run: {
    id: string; status: string; engine: 'server' | 'runtime'; provider: string; endReason: string | null; resumeAt: Date | null;
    stopRequestedAt: Date | null; stopRequestedBy: { id: string; name: string } | null; planLimitResetsAt: Date | null;
  } | null;
  /** The run that continues this one after the provider's limit, if there is one. */
  successor: { resumeAt: Date | null } | null;
  /** Changes of the run that wait for the owner's OK. */
  waitingChanges: number;
  /** Whether the agent itself last changed the task's owner: a real hand-back, not a person taking the task back. */
  handedBackByAgent?: boolean;
  /** The name of the person who holds the task, when that is not the agent's owner (someone took it): "the task is with Maja". */
  taskOwnerName?: string | null;
  /**
   * The other agent this one asked a question and is waiting for (#841), whose owner may stop its answer (the asking owner may not),
   * and the answer's run, which the provider's limit can pause like any other.
   */
  waitingForAnswer?: { name: string; ownerId: string; run: { status: string; engine: 'server' | 'runtime'; provider: string; endReason: string | null; resumeAt: Date | null } } | null;
}

const vendor = (run: { engine: string; provider: string }) => (run.engine === 'runtime' ? (run.provider === 'openai' ? 'ChatGPT' : 'Claude') : 'The API key');

/** The state line of an agent on a task: the line, the words, and what this reader may do about it. */
export function taskAgentState(facts: TaskAgentFacts): TaskAgentState {
  const { task, agent, run, successor, viewerId } = facts;
  const none = (): TaskAgentState => ({ agent, line: null, text: '', resumesAt: null, stoppedBy: null, canStop: false, canTryAgain: false, canTakeBack: false, canMarkDone: false, runId: run?.id ?? null });
  if (!agent || !run) return none();
  const holds = task.ownerAgentId === agent.id;
  const mine = agent.owner.id === viewerId;
  const who = mine ? 'you' : agent.owner.name;
  const state = (line: TaskAgentLine, text: string, extra: Partial<TaskAgentState> = {}): TaskAgentState => ({
    agent, line, text, resumesAt: null, stoppedBy: null, canStop: false, canTryAgain: false, canTakeBack: false, canMarkDone: false, runId: run.id, ...extra,
  });
  const mayStop = mine || facts.viewerIsAdmin;
  // Where the task is after the run stopped: with the agent's owner it went back to them (or is about to: the hand-back is the drain's next
  // step); if someone else took it, it is theirs.
  const whereNow = () => holds || task.ownerUserId === agent.owner.id ? ` · the task is back with ${who}`
    : task.ownerUserId ? ` · the task is with ${task.ownerUserId === viewerId ? 'you' : facts.taskOwnerName ?? 'someone else'}` : '';
  if (facts.waitingForAnswer && holds) {
    const answer = facts.waitingForAnswer;
    const mayStopAnswer = viewerId === answer.ownerId || facts.viewerIsAdmin;
    const resumes = answer.run.status === 'queued' && answer.run.resumeAt && answer.run.endReason !== 'no_room' ? answer.run.resumeAt : null;
    // A paused answer shows as paused, with when it resumes: it is not "didn't answer".
    if (resumes) return state('paused_by_limit', `Waiting for ${answer.name} to answer · ${answer.run.engine === 'server' ? 'the daily budget is used' : `${vendor(answer.run)} limit reached`}`,
      { resumesAt: resumes.toISOString(), canStop: mayStopAnswer });
    return state('working', `Waiting for ${answer.name} to answer…`, { canStop: mayStopAnswer });
  }
  if (IN_FLIGHT.has(run.status)) {
    if (!holds) return none();
    if (run.status === 'queued') {
      const resumes = run.resumeAt && run.endReason !== 'no_room' ? run.resumeAt : null;
      if (resumes) return state('paused_by_limit', run.engine === 'server' ? 'The daily budget is used' : `${vendor(run)} limit reached`, { resumesAt: resumes.toISOString(), canStop: mayStop });
      return state('waiting_for_room', run.endReason === 'no_room' ? 'Waiting for room on the server' : 'Waiting for its turn', { canStop: mayStop });
    }
    return state('working', run.stopRequestedAt ? 'Stopping…' : 'Working…', { canStop: mayStop && !run.stopRequestedAt });
  }
  // The provider's limit paused it: the run that continues it is queued and starts by itself.
  if (run.endReason === 'plan_limit' && successor) {
    return state('paused_by_limit', `${vendor(run)} limit reached`, { resumesAt: (successor.resumeAt ?? run.planLimitResetsAt)?.toISOString() ?? null, canStop: holds && mayStop });
  }
  if (facts.waitingChanges > 0) return state('waiting_for_ok', mine ? 'Waiting for your OK' : `Waiting for ${agent.owner.name}'s OK`);
  if (run.status === 'completed' || run.status === 'truncated') {
    if (task.status === 'done' && holds) return state('done', mine ? 'Marked done · you were told' : 'Marked done', { canTakeBack: mine });
    // Back with its owner to check only when the agent handed it back: a person who took the task back says nothing here.
    if (!holds && facts.handedBackByAgent && task.ownerUserId === agent.owner.id && task.status !== 'done')
      return state('handed_back', mine ? 'Back with you to check' : `Back with ${agent.owner.name} to check`, { canMarkDone: mine });
    return none();
  }
  if (run.status === 'stopped') {
    if (task.status === 'done') return none();
    // AI turned off in the space (C-17): the owner is told here, where they asked, because the agent can no longer write there.
    if (run.endReason === 'ai_off') return state('stopped', `Stopped: AI was turned off in this space${whereNow()}`);
    const by = run.stopRequestedBy;
    return state('stopped', `Stopped by ${by?.id === viewerId ? 'you' : by?.name ?? 'someone'}${whereNow()}`, { stoppedBy: by });
  }
  if (!holds) return none();
  const reason = run.endReason === 'sign_in_again' ? `Sign in to ${vendor(run)} again` : run.status === 'denied' || run.status === 'revoked' ? 'No longer allowed here' : 'Couldn\'t finish';
  return state('failed', reason, { canTryAgain: mine, canTakeBack: mine, canStop: false });
}
