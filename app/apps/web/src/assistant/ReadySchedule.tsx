import { useEffect, useMemo, useState } from 'react';
import type { AssistantJob } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { Button } from '../ui';
import { ScheduleSheet } from './ScheduleSheet';
import { listSchedules, updateSchedule, type ScheduleScope } from './scheduleApi';
import { draftOf } from './scheduleForm';
import './schedules.css';

// "Set up by asking" (F-027 AST-7, Journey 4): under the owner's own answer, the schedule that request prepared, off, with the one tap
// that turns it on. Only the owner's answer gets it; nobody else ever sees a schedule.

const recent = new Map<string, { at: number; list: Promise<AssistantJob[]> }>();
/** One read of the owner's schedules is shared by the answers of a conversation drawn together. */
function sharedList(scope: ScheduleScope): Promise<AssistantJob[]> {
  const key = `${scope.workspaceId}:${scope.ownerId}`;
  const known = recent.get(key);
  if (known && Date.now() - known.at < 4000) return known.list;
  const list = listSchedules(scope).catch(() => [] as AssistantJob[]);
  recent.set(key, { at: Date.now(), list });
  return list;
}

export function ReadySchedule({ runId, projectId, body }: { runId: string; projectId: string; body: string }) {
  const { me, projects } = useShellData();
  const workspaceId = projects.find((project) => project.id === projectId)?.workspaceId;
  const scope = useMemo<ScheduleScope | null>(() => (workspaceId ? { workspaceId, ownerId: me.user.id } : null), [workspaceId, me.user.id]);
  const [job, setJob] = useState<AssistantJob | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!scope) return undefined;
    let current = true;
    void sharedList(scope).then((items) => { if (current) setJob(items.find((item) => item.preparedRunId === runId) ?? null); });
    return () => { current = false; };
  }, [scope, runId]);
  if (!scope || !job) return null;
  const turnOn = async () => {
    setBusy(true); setError('');
    try { setJob(await updateSchedule(scope, job.id, { expectedVersion: job.version, enabled: true })); recent.delete(`${scope.workspaceId}:${scope.ownerId}`); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') setSheet(true);
      else setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'That didn’t work. Nothing changed; try again.');
    } finally { setBusy(false); }
  };
  return (
    <div className="asched-ready" data-prepared-schedule={job.id}>
      {job.enabled ? <span>{job.title}, {job.words}: on</span> : <>
        {/* The answer may already say it ("Ready: …"): then the card only offers the tap. */}
        <span>{body.includes(`Ready: ${job.title}`) ? 'Off until you turn it on' : `Ready: ${job.title}, ${job.words}`}</span>
        <Button variant="secondary" busy={busy} onClick={() => void turnOn()}>Turn on</Button>
      </>}
      {error ? <p className="asched-ready__error" role="alert">{error}</p> : null}
      <ScheduleSheet open={sheet} onClose={() => setSheet(false)} scope={scope} projects={projects.filter((project) => project.workspaceId === workspaceId)} initial={draftOf(job)} job={job} turnOn
        onSaved={(saved) => { setJob(saved); recent.delete(`${scope.workspaceId}:${scope.ownerId}`); }} />
    </div>
  );
}
