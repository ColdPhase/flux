import { useState } from 'react';
import { ASSISTANT_SCHEDULE_STARTERS, type AssistantJob, type MyAgent } from '@flux/contracts';
import { Button, Icon, Spinner } from '../ui';
import { ChangeSchedule } from './ChangeSchedule';
import { scheduleWhen, whenText } from './schedules';
import type { AgentSchedulesState } from './useAgentSchedules';

// An agent's schedules (F-036 AG-9, #858; mockup AgentReports "Schedules are listed in the conversation's header"): the owner's own sentences, told to
// the agent in its chat. The line in the conversation's header opens the one list (#1419: the chat is the only place); there they are turned on, paused,
// changed, run now and deleted, and their results arrive in the chat. The morning summary is a ready-made one, offered once, by Assistant in its chat
// while it has no schedule, off until the person turns it on.

/** What the owner is shown before a schedule runs while they are away, once per account: the note, then the tap that confirms. */
function NoteLine({ state }: { state: AgentSchedulesState }) {
  const { note } = state;
  if (!note) return null;
  return (
    <div className="agp__note" role="group" aria-label="Before it runs while you are away">
      <p>{note.note.note ?? note.note.meta}</p>
      <div className="aset__actions">
        <Button variant="primary" size="sm" busy={state.busy === note.key} onClick={() => void note.go(note.note.version)}>Turn on</Button>
        <Button variant="quiet" size="sm" onClick={state.dismissNote}>Not now</Button>
      </div>
    </div>
  );
}

/** "Every weekday at 9:00 · Off · Next Mon 9:00 · Done: …". */
function detail(job: AssistantJob) {
  const parts = [scheduleWhen(job)];
  if (!job.enabled) parts.push('Off');
  else if (job.next[0]) parts.push(`Next ${job.next[0].label}`);
  if (job.last) parts.push(`${whenText(job.last.at, job.timeZone)}: ${job.last.line}`);
  return parts.join(' · ');
}

function Row({ job, state, agent }: { job: AssistantJob; state: AgentSchedulesState; agent: MyAgent }) {
  const { busy } = state;
  const [changing, setChanging] = useState(false);
  return (
    <li className="sset-row agp__item agp__schedule" data-schedule={job.id}>
      <span className="sset-row__b">
        <span className="sset-row__t agp__item-text">{job.title}</span>
        <span className="sset-row__s">{detail(job)}</span>
      </span>
      <span className="agp__schedule-actions">
        {job.enabled
          ? <Button variant="quiet" size="sm" busy={busy === job.id} aria-label={`Pause ${job.title}`} onClick={() => void state.pause(job)}>Pause</Button>
          : <Button variant="outline" size="sm" busy={busy === job.id} aria-label={`Turn on ${job.title}`} onClick={() => void state.turnOn(job)}>Turn on</Button>}
        <Button variant="quiet" size="sm" disabled={!!busy} aria-label={`Change ${job.title}`} aria-expanded={changing} onClick={() => setChanging((value) => !value)}>Change</Button>
        <Button variant="quiet" size="sm" disabled={!!busy || job.running} aria-label={`Run ${job.title} now`} onClick={() => void state.runNow(job)}>{job.running ? 'Working…' : 'Run now'}</Button>
        <Button variant="quiet" size="sm" disabled={!!busy} aria-label={`Delete ${job.title}`} onClick={() => void state.remove(job)}>Delete</Button>
      </span>
      {changing ? <ChangeSchedule job={job} state={state} agentName={agent.name} onDone={() => setChanging(false)} /> : null}
    </li>
  );
}

/** The one list of an agent's schedules: Turn on or Pause, Change, Run now and Delete with Undo. In the conversation's header only (#1419). */
export function ScheduleList({ agent, state }: { agent: MyAgent; state: AgentSchedulesState }) {
  const { jobs } = state;
  return (
    <>
      {jobs === null && !state.failed ? <p className="sset-note"><Spinner label="Loading schedules" /></p> : null}
      {state.failed ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />Schedules couldn’t be loaded. <button type="button" className="ui-link" onClick={() => void state.reload()}>Try again</button></p> : null}
      {jobs?.length ? (
        <ul className="sset-card agp__memory" aria-label={`${agent.name}’s schedules`}>
          {jobs.map((job) => <Row key={job.id} job={job} state={state} agent={agent} />)}
        </ul>
      ) : null}
      <NoteLine state={state} />
      {state.undo ? <p className="sset-note" role="status">Deleted “{state.undo.title}”. <button type="button" className="ui-link" disabled={!!state.busy} onClick={() => void state.undoRemove()}>Undo</button></p> : null}
      {state.error && !state.note ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{state.error}</p> : null}
    </>
  );
}

/**
 * The line in the conversation's header that lists the schedules (AG-9, mockup "Every weekday 9:00 · new tasks summary · 1 schedule ›"):
 * the first one in words, how many there are, and the one list opens below it. No schedules, no line.
 */
export function ScheduleHeader({ agent, state }: { agent: MyAgent; state: AgentSchedulesState }) {
  const [open, setOpen] = useState(false);
  const jobs = state.jobs ?? [];
  // A schedule that was just deleted can still be put back: keep the line (and its Undo) until the person leaves it.
  if (!jobs.length && !(open && state.undo)) {
    // A read that failed is not "no schedules": the row's place says so, with Try again (#1369).
    if (state.failed) return <p className="nset__error agc__sched-failed" role="alert"><Icon name="alert" size={14} />Schedules couldn’t be loaded. <button type="button" className="ui-link" onClick={() => void state.reload()}>Try again</button></p>;
    return agent.answersAi && state.jobs ? <MorningSummary state={state} /> : null;
  }
  const first = jobs.find((job) => job.enabled) ?? jobs[0];
  return (
    <div className="agc__sched" data-schedules-header="">
      <button type="button" className="agc__sched-row" aria-expanded={open} aria-controls="agent-schedules-panel" onClick={() => setOpen((value) => !value)}>
        <Icon name="clock" size={16} />
        <span className="agc__sched-text">{first ? `${scheduleWhen(first)} · ${first.title}${first.enabled ? '' : ' · Off'}` : 'No schedules'}</span>
        <span className="agc__sched-count">{jobs.length === 1 ? '1 schedule' : `${jobs.length} schedules`}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
      </button>
      {open ? <div className="agc__sched-panel" id="agent-schedules-panel" role="region" aria-label={`${agent.name}’s schedules`}><ScheduleList agent={agent} state={state} /></div> : null}
    </div>
  );
}

/**
 * Under the agent's answer in its chat, as drawn: the schedule that sentence prepared, what it will do, the one tap that turns it on (AG-9 "confirms it
 * there"), and Change.
 */
export function ReadySchedule({ job, state, agent }: { job: AssistantJob; state: AgentSchedulesState; agent: MyAgent }) {
  const [changing, setChanging] = useState(false);
  return (
    <div className="agc__ready" data-prepared-schedule={job.id}>
      <p className="agc__ready-when"><Icon name="clock" size={15} /><b>{scheduleWhen(job)}</b><span> · {job.title}</span></p>
      <p className="agc__ready-text">{job.text}</p>
      <div className="agc__ready-actions">
        {job.enabled
          ? <span className="agc__on"><Icon name="check" size={14} />Turned on</span>
          : <Button variant="outline" size="sm" busy={state.busy === job.id} onClick={() => void state.turnOn(job)}>Turn on</Button>}
        <Button variant="quiet" size="sm" disabled={!!state.busy} aria-expanded={changing} onClick={() => setChanging((value) => !value)}>Change</Button>
        {job.enabled ? null : <span className="agc__ready-off">Off until you turn it on.</span>}
      </div>
      {changing ? <ChangeSchedule job={job} state={state} agentName={agent.name} onDone={() => setChanging(false)} /> : null}
      <NoteLine state={state} />
      {state.error && !state.note ? <p className="assistant-answer__error" role="alert">{state.error}</p> : null}
    </div>
  );
}

/**
 * The morning summary, offered once, by Assistant (#1419, AG-9): while the agent that answers `/ai` has no schedule, its chat shows this one row in the
 * place of the schedule line. Turn on makes it at once (the tap is the confirmation); then it is an ordinary schedule in that line.
 */
function MorningSummary({ state }: { state: AgentSchedulesState }) {
  const starter = ASSISTANT_SCHEDULE_STARTERS[0];
  return (
    <div className="agc__sched" data-starter={starter.id}>
      <div className="agc__sched-row agc__sched-offer">
        <Icon name="clock" size={16} />
        <span className="agc__sched-text">{starter.title} · Every weekday at 9:00</span>
        <Button variant="outline" size="sm" busy={state.busy === starter.id} aria-label={`Turn on ${starter.title}`} onClick={() => void state.addStarter(starter)}>Turn on</Button>
      </div>
      <NoteLine state={state} />
      {state.error && !state.note ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{state.error}</p> : null}
    </div>
  );
}
