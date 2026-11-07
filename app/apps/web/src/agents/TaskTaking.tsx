import { useEffect, useId, useState } from 'react';
import type { TaskTaking as Taking } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Icon, Option, Select } from '../ui';
import { getTaskTaking, setTaskTaking } from './taskAgents';

// "When someone assigns a task to me" (#856, F-036 AG-5; mockup Main): the one setting that lets an agent take what others give
// you. Do nothing is the default; the other choice names exactly one of your agents. To give one task to another agent you
// change its Owner field. Saved as it is chosen, and the row shows what the server kept.

const DO_NOTHING = '';

export function TaskTaking() {
  const [taking, setTaking] = useState<Taking | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = useId();
  const hint = useId();
  useEffect(() => {
    const controller = new AbortController();
    getTaskTaking(controller.signal).then(setTaking, () => { if (!controller.signal.aborted) setError('This couldn’t load.'); });
    return () => controller.abort();
  }, []);
  // Without an agent of your own there is nothing to give a task to.
  if (!taking?.agents.length) return error ? <p className="sset-note" role="alert">{error}</p> : null;
  const choose = async (value: string) => {
    setBusy(true); setError(''); setSaved(false);
    try { setTaking(await setTaskTaking(value === DO_NOTHING ? null : value)); setSaved(true); }
    catch (cause) { setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'Couldn’t save. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <section className="sset-gap" aria-labelledby={label} data-task-taking="">
      <ul className="sset-card">
        <li className="sset-row">
          <span className="sset-row__ic" aria-hidden="true"><Icon name="inbox" size={16} /></span>
          <span className="sset-row__b">
            <span className="sset-row__t" id={label}>When someone assigns a task to me</span>
            <span className="sset-row__s" id={hint}>The agent starts on it in the task. Only you give your agents instructions.</span>
          </span>
          <Select value={taking.takes ?? DO_NOTHING} disabled={busy} aria-labelledby={label} aria-describedby={hint} onChange={(next) => void choose(next)}>
            <Option value={DO_NOTHING}>Do nothing</Option>
            {taking.agents.map((agent) => <Option key={agent.id} value={agent.id}>Give it to {agent.name}</Option>)}
          </Select>
        </li>
      </ul>
      <p className="sset-note" role="status" aria-live="polite">{error || (saved ? 'Saved' : '')}</p>
    </section>
  );
}
