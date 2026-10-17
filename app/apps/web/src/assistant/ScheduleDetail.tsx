import { useEffect, useId, useState } from 'react';
import type { AssistantJob, AssistantJobRun } from '@flux/contracts';
import { SwitchRow } from '../app/SettingsHome';
import { Button, Icon, IconButton } from '../ui';
import { scheduleHistory, type ScheduleScope } from './scheduleApi';
import { whenText } from './scheduleForm';
import { SheetFrame } from './ScheduleSheet';
import './schedules.css';

// One schedule's panel (F-027 AST-7 "Controls"): Run now, on and off, Edit, Delete with Undo, and its last twenty runs, each in the
// plain words of its result. A dialog on the computer, a sheet on the phone, as the assistant's own panel is.

export function ScheduleDetail({ job, scope, onClose, onToggle, onRunNow, onEdit, onDelete }: {
  job: AssistantJob | null; scope: ScheduleScope; onClose: () => void;
  onToggle: (job: AssistantJob, on: boolean) => Promise<string | null>;
  onRunNow: (job: AssistantJob) => Promise<string | null>;
  onEdit: (job: AssistantJob) => void;
  onDelete: (job: AssistantJob) => Promise<string | null>;
}) {
  return (
    <SheetFrame open={!!job} onClose={onClose} label={job ? job.title : 'Schedule'}>
      {job ? <Body job={job} scope={scope} onClose={onClose} onToggle={onToggle} onRunNow={onRunNow} onEdit={onEdit} onDelete={onDelete} /> : null}
    </SheetFrame>
  );
}

function Body({ job, scope, onClose, onToggle, onRunNow, onEdit, onDelete }: {
  job: AssistantJob; scope: ScheduleScope; onClose: () => void;
  onToggle: (job: AssistantJob, on: boolean) => Promise<string | null>;
  onRunNow: (job: AssistantJob) => Promise<string | null>;
  onEdit: (job: AssistantJob) => void;
  onDelete: (job: AssistantJob) => Promise<string | null>;
}) {
  const titleId = useId();
  const [history, setHistory] = useState<AssistantJobRun[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'run' | 'delete'>('');
  const marker = `${job.last?.at ?? ''}|${job.last?.line ?? ''}|${job.running}`;
  useEffect(() => {
    const controller = new AbortController();
    scheduleHistory(scope, job.id, controller.signal).then(setHistory, () => { if (!controller.signal.aborted) setHistory([]); });
    return () => controller.abort();
  }, [job.id, marker]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (kind: 'run' | 'delete', work: () => Promise<string | null>) => {
    setBusy(kind); setError('');
    const failure = await work();
    setBusy('');
    if (failure) setError(failure);
    else if (kind === 'delete') onClose();
  };
  return (
    <div className="asched asched--detail" role="group" aria-labelledby={titleId}>
      <header className="asched__head ui-panel__head">
        <h2 className="asched__title" id={titleId}>{job.title}</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </header>
      <div className="asched__body">
        <p className="asched__lead">{job.words} · {job.projectName}</p>
        <blockquote className="asched__quote">{job.text}</blockquote>
        <p className="asched__facts">
          {job.enabled && job.next[0] ? <span>Next: {job.next.map((item) => item.label).join(', ')}</span> : <span>{job.pausedReason ? 'Paused' : 'Off'}</span>}
          {job.running ? <span>Working…</span> : job.last ? <span>Last: {job.last.line}</span> : null}
        </p>
        <div className="asched__actions">
          <Button variant="primary" busy={busy === 'run'} disabled={job.running} onClick={() => void act('run', () => onRunNow(job))}>Run now</Button>
          <Button variant="secondary" onClick={() => onEdit(job)}>Edit</Button>
          <Button variant="quiet" busy={busy === 'delete'} onClick={() => void act('delete', () => onDelete(job))}><Icon name="trash" size={14} />Delete</Button>
        </div>
        <div className="sset-card asched__switch">
          <SwitchRow label="On" detail={job.pausedReason ? 'Paused after three failed runs' : undefined} checked={job.enabled} onChange={(on) => void onToggle(job, on).then((failure) => setError(failure ?? ''))} />
        </div>
        {error ? <p className="asched__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
        <h3 className="asched__sub">History</h3>
        {history === null ? <p className="asched__none" aria-busy="true">Loading…</p>
          : history.length ? (
            <ol className="asched__history">
              {history.map((run) => <li key={run.id}><time dateTime={run.firedAt}>{whenText(run.firedAt, job.timeZone)}</time> · {run.line}</li>)}
            </ol>
          ) : <p className="asched__none">Nothing has run yet.</p>}
      </div>
    </div>
  );
}
