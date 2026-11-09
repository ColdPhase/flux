import { useId, useState } from 'react';
import type { AssistantJob, AssistantJobSchedule } from '@flux/contracts';
import { Button, Option, Select } from '../ui';
import type { AgentSchedulesState } from './useAgentSchedules';

// Change (F-036 AG-9, #858; mockup AgentReports "Turned on · Change"): what a schedule does, in the owner's own words, and for a daily, weekday or
// weekly one the time. Any other time is changed by telling the agent. Change edits the wording only: the web addresses a run of the schedule may
// read were fixed when it was prepared, from the owner's own request (C-30), so an address typed here is not read; the owner asks the agent again.

/** A time input wants "09:00"; a schedule may hold "9:00". */
const clockValue = (at: string) => (/^\d:\d\d$/.test(at) ? `0${at}` : at);

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The kinds whose time is one clock time (and a weekday): the others are changed by telling the agent. */
const timed = (schedule: AssistantJobSchedule): schedule is Extract<AssistantJobSchedule, { kind: 'daily' | 'weekdays' | 'weekly' }> =>
  schedule.kind === 'daily' || schedule.kind === 'weekdays' || schedule.kind === 'weekly';

export function ChangeSchedule({ job, state, agentName, onDone }: { job: AssistantJob; state: AgentSchedulesState; agentName: string; onDone: () => void }) {
  const id = useId();
  const [text, setText] = useState(job.text);
  const [at, setAt] = useState(timed(job.schedule) ? clockValue(job.schedule.at) : '');
  const [weekday, setWeekday] = useState(job.schedule.kind === 'weekly' ? job.schedule.weekday : 1);
  const same = text.trim() === job.text && (!timed(job.schedule) || (at === clockValue(job.schedule.at) && (job.schedule.kind !== 'weekly' || weekday === job.schedule.weekday)));
  async function save() {
    if (same) { onDone(); return; }
    const schedule: AssistantJobSchedule | null = !timed(job.schedule) || !at ? null
      : job.schedule.kind === 'weekly' ? { kind: 'weekly', at, weekday } : { kind: job.schedule.kind, at };
    if (await state.change(job, { text, ...(schedule ? { schedule } : {}) })) onDone();
  }
  return (
    <form className="agc__change" aria-label={`Change ${job.title}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="agp__label" htmlFor={`${id}-text`}>What {agentName} does each time</label>
      <textarea id={`${id}-text`} className="agp__input agp__text" rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
      <p className="agp__hint">The web addresses {agentName} may read are the ones in your request. To add one, ask {agentName} again in the chat.</p>
      {timed(job.schedule) ? (
        <div className="agc__change-when">
          {job.schedule.kind === 'weekly' ? (
            <Select aria-label="Day" value={weekday} onChange={(next) => setWeekday(Number(next))}>
              {DAYS.map((name, index) => <Option key={name} value={index + 1}>{name}</Option>)}
            </Select>
          ) : <span className="agp__hint">{job.schedule.kind === 'daily' ? 'Every day' : 'Weekdays'}</span>}
          <input className="agp__input agc__time-input" type="time" aria-label="Time" value={at} onChange={(event) => setAt(event.target.value)} />
        </div>
      ) : <p className="agp__hint">To change when it runs, tell {agentName}.</p>}
      <div className="agc__change-actions">
        <Button type="submit" variant="primary" size="sm" busy={state.busy === job.id} disabled={!text.trim()}>Save</Button>
        <Button type="button" variant="quiet" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
