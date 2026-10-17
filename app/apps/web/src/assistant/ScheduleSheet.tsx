import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { AssistantBackgroundNote, AssistantJob, AssistantJobPreview, ConversationSummary, CreateAssistantJob, UpdateAssistantJob } from '@flux/contracts';
import { ApiError } from '../api/client';
import type { ProjectSummary } from '../app/data';
import { Button, Icon, IconButton, MEDIA, Overlay, Sheet, useMediaQuery } from '../ui';
import { getBackgroundNote, previewSchedule, recentConversations, createSchedule, updateSchedule, setMorningSummary, type ScheduleScope } from './scheduleApi';
import { WEEKDAYS, browserZone, scheduleOf, shortTime, type Draft, type Frequency } from './scheduleForm';
import './schedules.css';

// The "On a schedule" sheet (F-027 AST-10 "The assistant screen"): what it should do, when, where, the next times, More, the note
// about background use when this account has not seen it, and [Cancel] [Turn on]. A dialog on the computer, a full sheet with a
// grabber on the phone. The same frame holds the small morning-summary sheet.

/** The frame both sheets share: a dialog on the computer, the full sheet with its grabber on the phone. */
export function SheetFrame({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const phone = useMediaQuery(MEDIA.phone);
  return phone
    ? <Sheet open={open} onClose={onClose} label={label} className="asched-sheet">{open ? children : null}</Sheet>
    : <Overlay placement="center" open={open} onClose={onClose} label={label} className="asched-dialog">{open ? children : null}</Overlay>;
}

const TIMES = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`);
/** A time of day in quarters of an hour, always written the 24-hour way the drawing shows it ("16:00"). */
function TimeSelect({ value, label, disabled, onChange }: { value: string; label: string; disabled?: boolean; onChange: (value: string) => void }) {
  const options = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();
  return <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((time) => <option key={time} value={time}>{time}</option>)}</select>;
}

const FREQUENCIES: Frequency[] = ['daily', 'weekdays', 'weekly', 'hourly'];
const frequencyLabel = (frequency: Frequency, weekday: number) =>
  frequency === 'daily' ? 'Every day' : frequency === 'weekdays' ? 'Weekdays' : frequency === 'weekly' ? `Every ${WEEKDAYS[weekday - 1]}` : 'Every hour while I work';

const failureText = (error: unknown) => (error instanceof ApiError && error.status < 500 ? error.message : 'That didn’t work. Nothing changed; try again.');

/** The note about background use (when the account has not seen it) and the one meta line that follows every sheet. */
export function NoteLines({ note }: { note: AssistantBackgroundNote | null }) {
  if (!note) return null;
  return (
    <>
      <p className="asched__meta">{note.meta}</p>
      {note.note ? <p className="asched__note" role="note">{note.note}</p> : null}
    </>
  );
}

export function useBackgroundNote(scope: ScheduleScope) {
  const [note, setNote] = useState<AssistantBackgroundNote | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getBackgroundNote(scope, controller.signal).then(setNote, () => undefined);
    return () => controller.abort();
  }, [scope.workspaceId, scope.ownerId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [note, setNote] as const;
}

export function ScheduleSheet({ open, onClose, scope, projects, initial, job = null, turnOn = true, onSaved }: {
  open: boolean; onClose: () => void; scope: ScheduleScope; projects: ProjectSummary[]; initial: Draft;
  /** The schedule being changed; absent for a new one. */
  job?: AssistantJob | null;
  /** The primary button turns it on (a new or prepared schedule) or only saves (an edit). */
  turnOn?: boolean;
  onSaved: (job: AssistantJob) => void;
}) {
  return (
    <SheetFrame open={open} onClose={onClose} label={job ? 'Change this schedule' : 'On a schedule'}>
      <Body onClose={onClose} scope={scope} projects={projects} initial={initial} job={job} turnOn={turnOn} onSaved={onSaved} />
    </SheetFrame>
  );
}

function Body({ onClose, scope, projects, initial, job, turnOn, onSaved }: {
  onClose: () => void; scope: ScheduleScope; projects: ProjectSummary[]; initial: Draft; job: AssistantJob | null; turnOn: boolean; onSaved: (job: AssistantJob) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() => ({ ...initial, projectId: projects.some((project) => project.id === initial.projectId) ? initial.projectId : projects[0]?.id ?? '' }));
  const [note] = useBackgroundNote(scope);
  const [noteNow, setNoteNow] = useState<AssistantBackgroundNote | null>(null);
  const [preview, setPreview] = useState<AssistantJobPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [moreOpen, setMoreOpen] = useState(() => !!initial.cron || !!initial.conversationId);
  const zone = job?.timeZone ?? browserZone();
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const schedule = useMemo(() => scheduleOf(draft), [draft]);
  const key = JSON.stringify(schedule);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { text.current?.focus({ preventScroll: true }); }, []);

  // The next times, in the owner's zone, from the server's own reading of the schedule (the same one the tick uses).
  useEffect(() => {
    if (!schedule) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewSchedule(scope, schedule, zone, controller.signal).then((result) => { setPreview(result); setPreviewError(''); },
        (cause: unknown) => { if (!controller.signal.aborted) { setPreview(null); setPreviewError(cause instanceof ApiError ? cause.message : ''); } });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!moreOpen || !draft.projectId) return undefined;
    const controller = new AbortController();
    recentConversations(draft.projectId, controller.signal).then(setConversations, () => setConversations([]));
    return () => controller.abort();
  }, [moreOpen, draft.projectId]);

  const group = useRef<HTMLDivElement>(null);
  const cronOn = draft.cron.trim() !== '';
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = FREQUENCIES[(FREQUENCIES.indexOf(draft.frequency) + delta + FREQUENCIES.length) % FREQUENCIES.length]!;
    set({ frequency: next });
    requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-frequency="${next}"]`)?.focus());
  };

  const shownNote = noteNow ?? note;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !draft.text.trim() || !draft.projectId) return;
    setBusy(true); setError('');
    const post = draft.conversationId !== '';
    const noteVersion = shownNote?.note ? shownNote.version : undefined;
    try {
      let saved: AssistantJob;
      if (job) {
        const body = {
          expectedVersion: job.version, text: draft.text.trim(), ...(draft.projectId !== job.projectId ? { projectId: draft.projectId } : {}),
          ...(schedule ? { schedule, timeZone: zone } : {}), postToConversation: post, ...(post ? { conversationId: draft.conversationId } : {}),
          ...(turnOn ? { enabled: true, ...(noteVersion ? { noteVersion } : {}) } : {}),
        } as UpdateAssistantJob;
        saved = await updateSchedule(scope, job.id, body);
      } else {
        const body: CreateAssistantJob = {
          projectId: draft.projectId, ...(draft.title ? { title: draft.title } : {}), text: draft.text.trim(), schedule: schedule!, timeZone: zone, enabled: true,
          ...(post ? { postToConversation: true, conversationId: draft.conversationId } : {}), ...(noteVersion ? { noteVersion } : {}),
        };
        saved = await createSchedule(scope, body);
      }
      onSaved(saved);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') {
        // This account has not seen the note yet: show it, and the next tap is the Turn on it asks for.
        getBackgroundNote(scope).then(setNoteNow, () => undefined);
        setError('Read this first, then turn it on.');
      } else setError(failureText(cause));
    } finally { setBusy(false); }
  };

  return (
    <form className="asched" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <header className="asched__head ui-panel__head">
        <h2 className="asched__title" id={titleId}>{job ? 'Change this schedule' : 'On a schedule'}</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </header>
      <div className="asched__body">
        <label className="asched__field">
          <span className="asched__label">What should it do?</span>
          <textarea ref={text} className="asched__text" aria-label="What should it do?" rows={3} maxLength={4000} value={draft.text} placeholder="List what we finished this week"
            onChange={(event) => set({ text: event.target.value })} />
        </label>

        <div className="asched__field">
          <span className="asched__label" id={`${titleId}-when`}>When</span>
          {draft.once ? <p className="asched__fixed">{job?.words ?? 'Once'}</p> : (
            <div ref={group} className={`seg asched__seg${cronOn ? ' is-dimmed' : ''}`} role="radiogroup" aria-labelledby={`${titleId}-when`} onKeyDown={move}>
              {FREQUENCIES.map((frequency) => (
                <button key={frequency} type="button" role="radio" className="seg__b" data-frequency={frequency} aria-checked={draft.frequency === frequency && !cronOn}
                  tabIndex={draft.frequency === frequency ? 0 : -1} onClick={() => set({ frequency, cron: '' })}>{frequencyLabel(frequency, draft.weekday)}</button>
              ))}
            </div>
          )}
        </div>

        {draft.once ? null : (
          <div className={`asched__line${cronOn ? ' is-dimmed' : ''}`}>
            {draft.frequency === 'hourly' && !cronOn ? (
              <>
                <label className="asched__inline"><span className="asched__label">From</span>
                  <TimeSelect label="From" value={draft.from} onChange={(from) => set({ from })} /></label>
                <label className="asched__inline"><span className="asched__label">until</span>
                  <TimeSelect label="Until" value={draft.to} onChange={(to) => set({ to })} /></label>
                <span className="asched__on">on weekdays</span>
              </>
            ) : (
              <>
                <label className="asched__inline"><span className="asched__label">At</span>
                  <TimeSelect label="At" value={draft.at} disabled={cronOn} onChange={(at) => set({ at })} /></label>
                <label className="asched__inline"><span className="asched__label">on</span>
                  <select aria-label="Day of the week" value={draft.weekday} disabled={cronOn || draft.frequency !== 'weekly'} onChange={(event) => set({ weekday: Number(event.target.value), frequency: 'weekly' })}>
                    {WEEKDAYS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
                  </select></label>
              </>
            )}
          </div>
        )}

        <label className="asched__field">
          <span className="asched__label">Where</span>
          <select className="asched__select" aria-label="Where" value={draft.projectId} disabled={!projects.length} onChange={(event) => set({ projectId: event.target.value, conversationId: '' })}>
            {projects.length ? projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>) : <option value="">No project yet</option>}
          </select>
        </label>

        <p className="asched__next" aria-live="polite">{draft.once ? '' : preview && !previewError ? `Next: ${preview.next.map((item) => item.label).join(', ')}` : previewError ? '' : 'Next: …'}</p>

        <details className="asched__more" open={moreOpen} onToggle={(event) => setMoreOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary><span>More</span><Icon name="chevron-right" size={12} /></summary>
          <div className="asched__morebody">
            <label className="asched__field">
              <span className="asched__label">Cron expression</span>
              <input className="asched__cron" aria-label="Cron expression" type="text" inputMode="text" autoCapitalize="off" spellCheck={false} placeholder="0 9 * * 1-5" value={draft.cron}
                aria-invalid={previewError ? true : undefined} aria-describedby={`${titleId}-cron`} onChange={(event) => set({ cron: event.target.value })} />
            </label>
            <p id={`${titleId}-cron`} className="asched__cronnote" role={previewError ? 'alert' : undefined}>
              {previewError ? previewError : cronOn && preview ? `In words: ${preview.words}` : 'Five fields: minute, hour, day of month, month, day of week. At most once an hour.'}
            </p>
            <label className="asched__field">
              <span className="asched__label">Post the result in</span>
              <select className="asched__select" aria-label="Post the result in" value={draft.conversationId} onChange={(event) => set({ conversationId: event.target.value })}>
                <option value="">Nowhere, keep it in Recent</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>{conversation.firstMessageBody.length > 60 ? `${conversation.firstMessageBody.slice(0, 59)}…` : conversation.firstMessageBody || 'Conversation'}</option>
                ))}
              </select>
            </label>
          </div>
        </details>

        <NoteLines note={shownNote} />
        {error ? <p className="asched__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      </div>
      <footer className="asched__foot">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy} disabled={!draft.text.trim() || !draft.projectId || !!previewError}>{turnOn ? 'Turn on' : 'Save'}</Button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** "Let your assistant write your morning summary": one small sheet, the note when this account has not seen it, and Turn on. */
export function MorningSummarySheet({ open, onClose, scope, time, onDone }: {
  open: boolean; onClose: () => void; scope: ScheduleScope; time: string | null; onDone: () => void;
}) {
  return (
    <SheetFrame open={open} onClose={onClose} label="Morning summary">
      <SummaryBody onClose={onClose} scope={scope} time={time} onDone={onDone} />
    </SheetFrame>
  );
}

function SummaryBody({ onClose, scope, time, onDone }: { onClose: () => void; scope: ScheduleScope; time: string | null; onDone: () => void }) {
  const titleId = useId();
  const [note, setNote] = useBackgroundNote(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await setMorningSummary({ on: true, ...(note?.note ? { noteVersion: note.version } : {}), timeZone: browserZone() });
      onDone();
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') {
        getBackgroundNote(scope).then(setNote, () => undefined);
        setError('Read this first, then turn it on.');
      } else setError(failureText(cause));
    } finally { setBusy(false); }
  };
  return (
    <form className="asched asched--small" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <header className="asched__head ui-panel__head">
        <h2 className="asched__title" id={titleId}>Morning summary</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </header>
      <div className="asched__body">
        <p className="asched__lead">Morning summary · {time ? shortTime(time) : '9:00'}, from Notifications · written by your assistant</p>
        <NoteLines note={note} />
        {error ? <p className="asched__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      </div>
      <footer className="asched__foot">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy}>Turn on</Button>
      </footer>
    </form>
  );
}

