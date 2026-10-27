import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { WorkStatus } from '@flux/contracts';
import { WORK_STATUSES } from '@flux/contracts';
import { Morph, StatusGlyph } from '../ui';
import { STATUS_LABEL } from './format';
import { PropertyMenu } from './PropertyMenu';

// The parts of the task panel that are edited where they are read (F-026 S9, S10): the state with
// keys 1-5, and the title. Neither has a Save button; both save when the person is done.

/** The digits `1`-`5` pick a state while the panel is open and nothing is being typed. */
export function useStateKeys(enabled: boolean, choose: (status: WorkStatus) => void) {
  const latest = useRef(choose);
  useEffect(() => { latest.current = choose; });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const status = WORK_STATUSES[Number(event.key) - 1];
      if (!status || event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]:not(#details)')) return;
      // Only while the focus is in the panel or nowhere in particular.
      if (target && target !== document.body && !target.closest('#details')) return;
      event.preventDefault();
      latest.current(status);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * The task's state: one row whose value opens the five states with their keys, on a computer and on a phone alike.
 * Choosing changes it at once; the panel offers Undo.
 */
export function StatusControl({ status, disabled, onChoose }: { status: WorkStatus; disabled?: boolean; onChoose: (status: WorkStatus) => void }) {
  const options = WORK_STATUSES.map((value, index) => ({ value, label: STATUS_LABEL[value], key: String(index + 1), icon: <StatusGlyph status={value} size={16} /> }));
  return (
    <PropertyMenu label="Status" value={status} options={options} disabled={disabled} onChoose={(value) => onChoose(value as WorkStatus)}>
      <StatusGlyph status={status} size={16} /><Morph value={status}>{STATUS_LABEL[status]}</Morph>
    </PropertyMenu>
  );
}

const dueFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
/** A calendar day (`YYYY-MM-DD`) as people read it, with no time zone shift. */
export const dueLabel = (day: string) => dueFormat.format(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const todayKey = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

/**
 * The due day, edited where it is read: "Add a date" or the day, a click opens the browser's own date field, choosing
 * saves at once and Clear takes it away. Past its day and not finished, the word says so.
 */
export function DueField({ value, editable, finished, disabled, onSave }: { value: string | null; editable: boolean; finished: boolean; disabled?: boolean; onSave: (day: string | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    field.current?.focus({ preventScroll: true });
    try { field.current?.showPicker?.(); } catch { /* The field is still there to type in. */ }
  }, [editing]);
  const leave = () => { setEditing(false); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); };
  const late = !!value && !finished && value < todayKey();
  const text = value ? dueLabel(value) : 'Add a date';
  if (!editable) return <span className="wd-value">{value ? <>{text}{late ? <span className="wd-muted"> · overdue</span> : null}</> : <span className="wd-muted">No date</span>}</span>;
  if (!editing) {
    return (
      <button ref={opener} type="button" className="wd-state wd-due" aria-label={value ? `Due ${text}` : 'Due, add a date'} disabled={disabled} onClick={() => setEditing(true)}>
        <span className={value ? undefined : 'wd-muted'}>{text}</span>{late ? <span className="wd-muted"> · overdue</span> : null}
      </button>
    );
  }
  return (
    <span className="wd-due-edit" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leave(); } }}>
      <input ref={field} type="date" className="wd-due-edit__field" aria-label="Due date" value={value ?? ''} min="1970-01-01" max="9999-12-31"
        onChange={(event) => { const next = event.target.value; if (next && next !== value) void onSave(next).then((ok) => { if (ok) leave(); }); }} />
      {value ? <button type="button" className="wd-due-edit__clear" onClick={() => void onSave(null).then((ok) => { if (ok) leave(); })}>Clear</button> : null}
      <button type="button" className="wd-due-edit__clear" onClick={leave}>Cancel</button>
    </span>
  );
}

/**
 * The title, edited where it is read: it looks like the heading, a click or Enter makes it a field,
 * Enter or leaving it saves, Esc puts the old title back. The field stays open with the person's
 * text until the save is confirmed, so a failed save can be retried without retyping.
 */
export function TitleField({ title, editable, onEdit, onDraftChange, onSave }: { title: string; editable: boolean; onEdit?: () => void; onDraftChange?: () => void; onSave: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [original, setOriginal] = useState(title);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const attempted = useRef<string | null>(null);
  const edits = useRef(0);
  useLayoutEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  function leave() {
    setEditing(false);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  }
  async function save(fromBlur: boolean) {
    const next = draft.trim();
    if (saving) return;
    if (!next || next === title) { leave(); return; }
    // Leaving the field after a failed attempt does not send the same text again by itself.
    if (fromBlur && attempted.current === next) return;
    attempted.current = next;
    setSaving(true);
    const edit = edits.current;
    const ok = await onSave(next);
    setSaving(false);
    if (ok) { attempted.current = null; if (edits.current === edit) leave(); }
  }
  function cancel() {
    attempted.current = null;
    setDraft(title);
    leave();
  }
  if (!editable) return <h3 className="details__title">{title}</h3>;
  return (
    <h3 className="details__title wd-title">
      {editing ? (
        <>
          <span className="ui-vh" id={labelId}>Task title</span>
          <textarea ref={field} aria-labelledby={labelId} rows={1} maxLength={200} value={draft} className="wd-title__field" aria-busy={saving}
            onChange={(event) => { edits.current++; onDraftChange?.(); setDraft(event.target.value.replace(/\n/g, ' ')); }}
            onBlur={() => void save(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(false); }
              else if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); cancel(); }
            }} />
          {title !== original ? <span className="wd-muted">Now: {title}</span> : null}
        </>
      ) : (
        <button ref={opener} type="button" className="wd-title__text" title="Edit title" onClick={() => { setDraft(title); setOriginal(title); setEditing(true); onEdit?.(); }}>{title}</button>
      )}
    </h3>
  );
}
