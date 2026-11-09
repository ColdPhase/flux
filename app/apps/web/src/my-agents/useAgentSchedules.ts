import { useCallback, useEffect, useState } from 'react';
import { ASSISTANT_SCHEDULE_STARTERS, type AssistantBackgroundNote, type AssistantJob, type UpdateAssistantJob } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { browserZone, createSchedule, deleteSchedule, getBackgroundNote, listSchedules, restoreSchedule, runScheduleNow, updateSchedule } from './schedules';

// One agent's schedules and what the person does with them (#858, AG-9): turn on, pause, run now, delete with Undo, and the ready-made ones. Turning
// one on may first show the note about running while the person is away (AST-2.1), once per account; the tap after it is the confirmation.

const FALLBACK_MS = 10_000;

export type Starter = (typeof ASSISTANT_SCHEDULE_STARTERS)[number];

export function failureWords(error: unknown) {
  if (error instanceof NetworkError) return 'Offline';
  if (error instanceof ApiError && error.status < 500 && error.message) return error.message;
  return 'That didn’t work. Nothing changed; try again.';
}

/**
 * `version` reads the schedules again (a run's event arrived, a prepared one was made); the state is the person's own list. While a run of one
 * works it also looks every ten seconds, in case the stream is reconnecting: the events are what normally say a run ended.
 */
export function useAgentSchedules(agentId: string, version = 0, onEnded?: () => void) {
  const [jobs, setJobs] = useState<AssistantJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** The note to read before turning this one on, with what to do after it. */
  const [note, setNote] = useState<{ key: string; note: AssistantBackgroundNote; go: (version: string) => Promise<void> } | null>(null);
  const [undo, setUndo] = useState<AssistantJob | null>(null);
  const read = useCallback(async () => {
    try { setJobs(await listSchedules(agentId)); setFailed(false); } catch { setFailed(true); }
  }, [agentId]);
  useEffect(() => {
    const controller = new AbortController();
    listSchedules(agentId, controller.signal).then((items) => { setJobs(items); setFailed(false); }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [agentId, version]);

  // While a run of a schedule works, read again until it is closed: the list settles an ended firing when it is read.
  const running = !!jobs?.some((job) => job.running);
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => { listSchedules(agentId).then(setJobs, () => undefined); }, FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [running, agentId]);

  const replace = (job: AssistantJob) => setJobs((list) => (list ?? []).map((item) => (item.id === job.id ? job : item)));
  /** Runs `work`; when the account needs the note first, shows it and runs `work` again with its version when the person confirms. */
  async function guarded(key: string, work: (noteVersion?: string) => Promise<void>) {
    setBusy(key); setError('');
    try { await work(); setNote(null); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') {
        try { setNote({ key, note: await getBackgroundNote(agentId), go: (noteVersion) => guarded(key, () => work(noteVersion)) }); }
        catch (inner) { setError(failureWords(inner)); }
      } else setError(failureWords(cause));
    } finally { setBusy(''); }
  }
  return {
    jobs, failed, error, busy, note, undo, reload: read,
    dismissNote: () => setNote(null),
    turnOn: (job: AssistantJob) => guarded(job.id, async (noteVersion) => { replace(await updateSchedule(agentId, job.id, { expectedVersion: job.version, enabled: true, ...(noteVersion ? { noteVersion } : {}) })); }),
    pause: (job: AssistantJob) => guarded(job.id, async () => { replace(await updateSchedule(agentId, job.id, { expectedVersion: job.version, enabled: false })); }),
    /** Change: what it does, and when for a daily, weekday or weekly one. True when it was saved. */
    async change(job: AssistantJob, changes: Pick<UpdateAssistantJob, 'text' | 'schedule'>) {
      setBusy(job.id); setError('');
      try { replace(await updateSchedule(agentId, job.id, { expectedVersion: job.version, ...changes })); return true; }
      catch (cause) { setError(failureWords(cause)); return false; }
      finally { setBusy(''); }
    },
    // A firing that could not start ends at once and says so in the chat (C-53): the chat reads again.
    runNow: (job: AssistantJob) => guarded(job.id, async () => { const done = await runScheduleNow(agentId, job.id); replace(done.job); if (done.run.state !== 'running') onEnded?.(); }),
    async remove(job: AssistantJob) {
      setBusy(job.id); setError('');
      try { await deleteSchedule(agentId, job.id); setJobs((list) => (list ?? []).filter((item) => item.id !== job.id)); setUndo(job); }
      catch (cause) { setError(failureWords(cause)); }
      finally { setBusy(''); }
    },
    async undoRemove() {
      if (!undo) return;
      setBusy(undo.id); setError('');
      try { const back = await restoreSchedule(agentId, undo.id); setJobs((list) => [...(list ?? []), back]); setUndo(null); }
      catch (cause) { setError(failureWords(cause)); }
      finally { setBusy(''); }
    },
    leaveUndo: () => setUndo(null),
    /** A ready-made schedule, on at once: the person's tap is the confirmation. */
    addStarter: (starter: Starter) => guarded(starter.id, async (noteVersion) => {
      const made = await createSchedule(agentId, { title: starter.title, text: starter.text, schedule: starter.schedule, timeZone: browserZone(), enabled: true, ...(noteVersion ? { noteVersion } : {}) });
      setJobs((list) => [...(list ?? []), made]);
    }),
  };
}
export type AgentSchedulesState = ReturnType<typeof useAgentSchedules>;
