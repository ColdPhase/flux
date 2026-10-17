import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantJob, AssistantMorningSummary, PersonalAssistantStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { SwitchRow } from '../app/SettingsHome';
import { getPreferences } from '../notifications/api';
import { Button, Icon, MEDIA, useMediaQuery, useToast } from '../ui';
import { ScheduleDetail } from './ScheduleDetail';
import { MorningSummarySheet, ScheduleSheet } from './ScheduleSheet';
import {
  deleteSchedule, getMorningSummary, listSchedules, restoreSchedule, runScheduleNow, setMorningSummary, updateSchedule, type ScheduleScope,
} from './scheduleApi';
import { blankDraft, draftOf, shortTime, weeklyReviewDraft, type Draft } from './scheduleForm';
import './schedules.css';

// "On a schedule" on the assistant screen (F-027 AST-7 and AST-10 "The assistant screen"): the morning summary row, one row per
// schedule with its words, next time and last result, the empty part's two starters, and "+ Add". Everything is the owner's own;
// the sheet and the panel hold the rest, so this part stays calm. While a run works the list asks again, so "Last: Done" appears
// by itself.

const failure = (cause: unknown) => (cause instanceof ApiError && cause.status < 500 ? cause.message : 'That didn’t work. Nothing changed; try again.');
const NOTE_REQUIRED = 'ASSISTANT_BACKGROUND_NOTE_REQUIRED';

type SheetState = { draft: Draft; job: AssistantJob | null; turnOn: boolean };

export function AssistantSchedules({ status, userId }: { status: PersonalAssistantStatus; userId: string }) {
  const workspaceId = status.enablement?.agents[0]?.workspaceId ?? null;
  const { projects: allProjects } = useShellData();
  const projects = useMemo(() => allProjects.filter((project) => project.workspaceId === workspaceId), [allProjects, workspaceId]);
  const scope = useMemo<ScheduleScope | null>(() => (workspaceId ? { workspaceId, ownerId: userId } : null), [workspaceId, userId]);
  const phone = useMediaQuery(MEDIA.phone);
  const toast = useToast();
  const [jobs, setJobs] = useState<AssistantJob[] | null>(null);
  const [summary, setSummary] = useState<AssistantMorningSummary | null>(null);
  // The morning summary row stays where it is for the visit, even after its switch goes off.
  const [summaryRow, setSummaryRow] = useState(false);
  const [time, setTime] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [summarySheet, setSummarySheet] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const fetchAll = useCallback((signal?: AbortSignal) => {
    if (!scope) return Promise.resolve();
    return Promise.all([listSchedules(scope, signal), getMorningSummary(signal).catch(() => null), getPreferences(signal).catch(() => null)]).then(([items, morning, prefs]) => {
      if (!mounted.current || signal?.aborted) return;
      setJobs(items); setSummary(morning); setTime(prefs?.morningSummary.at ?? null); setLoadFailed(false);
      if (morning?.byAssistant) setSummaryRow(true);
    }, () => { if (mounted.current && !signal?.aborted) setLoadFailed(true); });
  }, [scope]);
  const reload = useCallback(() => { void fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchAll(controller.signal);
    return () => controller.abort();
  }, [fetchAll]);

  // While a run works the owner's list settles it, so the row says "Last: Done …" without a reload.
  const working = !!jobs?.some((job) => job.running);
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
  }, [working, reload]);

  if (!scope) return null;
  const replace = (next: AssistantJob) => setJobs((current) => (current ?? []).some((job) => job.id === next.id) ? (current ?? []).map((job) => (job.id === next.id ? next : job)) : [...(current ?? []), next]);
  const openNew = (draft: Draft, job: AssistantJob | null = null, turnOn = true) => { setError(''); setDetailId(null); setSheet({ draft, job, turnOn }); };
  const firstProject = projects[0]?.id ?? '';

  /** Switch on or off. A first switch-on on an account that has not seen the note opens the sheet that shows it. */
  async function toggle(job: AssistantJob, on: boolean): Promise<string | null> {
    try {
      replace(await updateSchedule(scope!, job.id, { expectedVersion: job.version, enabled: on }));
      return null;
    } catch (cause) {
      if (on && cause instanceof ApiError && cause.code === NOTE_REQUIRED) { openNew(draftOf(job), job, true); return null; }
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') { reload(); return null; }
      return failure(cause);
    }
  }
  async function runNow(job: AssistantJob): Promise<string | null> {
    try { replace((await runScheduleNow(scope!, job.id)).job); return null; }
    catch (cause) { reload(); return failure(cause); }
  }
  async function remove(job: AssistantJob): Promise<string | null> {
    try {
      await deleteSchedule(scope!, job.id);
      setJobs((current) => (current ?? []).filter((item) => item.id !== job.id));
      toast({ message: `Deleted “${job.title}”`, timeout: 8000, action: { label: 'Undo', key: 'Z', onClick: () => {
        restoreSchedule(scope!, job.id).then(() => { if (mounted.current) reload(); }, () => toast({ message: 'Couldn’t bring it back. Try again.', tone: 'danger' }));
      } } });
      return null;
    } catch (cause) { return failure(cause); }
  }
  async function toggleSummary(on: boolean) {
    setError('');
    try {
      await setMorningSummary({ on });
      await fetchAll();
    } catch (cause) {
      if (on && cause instanceof ApiError && cause.code === NOTE_REQUIRED) setSummarySheet(true);
      else setError(failure(cause));
    }
  }

  const list = jobs ?? [];
  const detail = list.find((job) => job.id === detailId) ?? null;
  const summaryOn = !!summary?.byAssistant;
  // The empty part offers its starters; once there is a schedule they are gone, and Add stays last.
  const starters = jobs !== null && !list.length;

  return (
    <>
      <h3 className="aset-screen__h" id="asched-title">On a schedule</h3>
      <section className="sset-card asched__card" aria-labelledby="asched-title">
        {summaryRow ? (
          <SwitchRow label={phone ? 'Morning summary · by your assistant' : 'Morning summary · written by your assistant'} checked={summaryOn}
            detail={`Every day at ${time ? shortTime(time) : '9:00'} (Notifications) · Home`} onChange={(on) => void toggleSummary(on)} />
        ) : null}
        {list.map((job) => <Row key={job.id} job={job} onOpen={() => setDetailId(job.id)} onToggle={(on) => void toggle(job, on).then((message) => setError(message ?? ''))}
          onTurnOn={() => void toggle(job, true).then((message) => setError(message ?? ''))} />)}
        {jobs === null && !loadFailed ? <div className="sset-row"><span className="sset-row__s" aria-busy="true">Loading…</span></div> : null}
        {loadFailed ? <div className="sset-row"><span className="sset-row__s">Your schedules couldn’t load. <button type="button" className="ui-link" onClick={() => reload()}>Try again</button></span></div> : null}
        {starters ? (
          <div className="sset-row sset-row--stack asched__starters">
            <span className="sset-row__s">{summaryRow ? 'Try one:' : 'Nothing yet. Try one:'}</span>
            <div className="asched__chips">
              {summaryRow ? null : <button type="button" className="asched__chip" onClick={() => setSummarySheet(true)}>Let your assistant write your morning summary</button>}
              <button type="button" className="asched__chip" disabled={!firstProject} onClick={() => openNew(weeklyReviewDraft(firstProject))}>Weekly review on Monday</button>
            </div>
          </div>
        ) : null}
        <button type="button" className="sset-row sset-row--link asched__add" disabled={!firstProject} onClick={() => openNew(blankDraft(firstProject))}>
          <span className="sset-row__ic" aria-hidden="true"><Icon name="plus" size={14} /></span>
          <span className="sset-row__b"><span className="sset-row__t">Add</span></span>
        </button>
      </section>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}

      <ScheduleDetail job={detail} scope={scope} onClose={() => setDetailId(null)} onToggle={toggle} onRunNow={runNow} onDelete={remove} onEdit={(job) => openNew(draftOf(job), job, job.prepared)} />
      <ScheduleSheet open={!!sheet} onClose={() => setSheet(null)} scope={scope} projects={projects} initial={sheet?.draft ?? blankDraft(firstProject)} job={sheet?.job ?? null}
        turnOn={sheet?.turnOn ?? true} onSaved={(saved) => { replace(saved); reload(); }} />
      <MorningSummarySheet open={summarySheet} onClose={() => setSummarySheet(false)} scope={scope} time={time} onDone={() => { setSummaryRow(true); reload(); }} />
    </>
  );
}

/** One schedule: its name and switch, its words with the next time, its project and the last result; the rest is in its panel. */
function Row({ job, onOpen, onToggle, onTurnOn }: { job: AssistantJob; onOpen: () => void; onToggle: (on: boolean) => void; onTurnOn: () => void }) {
  const next = job.enabled ? job.next[0]?.label : null;
  const prepared = job.prepared && !job.enabled;
  const result = job.running ? 'Working…' : job.pausedReason ? `Paused: ${job.last?.line ?? 'it failed three times in a row'}` : job.last ? `Last: ${job.last.line}` : null;
  return (
    <div className="sset-row asched__row" data-schedule={job.id}>
      <button type="button" className="asched__main" onClick={onOpen}>
        <span className="sset-row__t">{prepared ? `Ready: ${job.title}, ${job.words}` : job.title}</span>
        {prepared ? <span className="sset-row__s">{job.projectName} · off until you turn it on</span> : (
          <>
            <span className="sset-row__s">{job.words}{next ? ` · Next: ${next}` : ''}</span>
            <span className="sset-row__s">{job.projectName}{result ? ` · ${result}` : ''}</span>
          </>
        )}
        <span className="asched__go" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
      </button>
      {prepared
        ? <Button variant="secondary" className="asched__turnon" onClick={onTurnOn}>Turn on</Button>
        : <button type="button" role="switch" className="sset-switch" aria-checked={job.enabled} aria-label={job.title} onClick={() => onToggle(!job.enabled)}><span aria-hidden="true" /></button>}
    </div>
  );
}
