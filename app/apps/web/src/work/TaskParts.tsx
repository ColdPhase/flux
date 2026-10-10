import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkStatus } from '@flux/contracts';
import { WORK_STATUSES } from '@flux/contracts';
import { Icon, MEDIA, StatusGlyph, useMediaQuery } from '../ui';
import { PANEL_META_ID } from '../ui/SidePanel';
import { STATUS_LABEL } from './format';

// The parts of the task panel that are edited where they are read (F-026 S9, S10): the state with
// keys 1-5, and the title. Neither has a Save button; both save when the person is done.

/** Puts a short piece of text, the task's number, in the detail panel's head beside its kind chip. */
const noSubscription = () => () => {};
export function PanelMeta({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(noSubscription, () => document.getElementById(PANEL_META_ID), () => null);
  return target ? createPortal(children, target) : null;
}

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
 * The task's state: on a phone five pills, on a computer one button that opens the five states with
 * their keys. Choosing changes it at once; the panel offers Undo.
 */
export function StatusControl({ status, disabled, onChoose }: { status: WorkStatus; disabled?: boolean; onChoose: (status: WorkStatus) => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? <StatusPills status={status} disabled={disabled} onChoose={onChoose} /> : <StatusMenu status={status} disabled={disabled} onChoose={onChoose} />;
}

function StatusPills({ status, disabled, onChoose }: { status: WorkStatus; disabled?: boolean; onChoose: (status: WorkStatus) => void }) {
  return (
    <div className="wd-pills" role="radiogroup" aria-label="Status">
      {WORK_STATUSES.map((value) => (
        <button key={value} type="button" role="radio" aria-checked={value === status} disabled={disabled} className="wd-pill" onClick={() => { if (value !== status) onChoose(value); }}>
          <StatusGlyph status={value} size={18} /><span>{STATUS_LABEL[value]}</span>
        </button>
      ))}
    </div>
  );
}

function StatusMenu({ status, disabled, onChoose }: { status: WorkStatus; disabled?: boolean; onChoose: (status: WorkStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => { if (open) items.current[active]?.focus({ preventScroll: true }); }, [open, active]);

  const choose = (value: WorkStatus) => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    if (value !== status) onChoose(value);
  };
  const openMenu = () => { setActive(Math.max(0, WORK_STATUSES.indexOf(status))); setOpen(true); };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setOpen(false); button.current?.focus({ preventScroll: true }); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % WORK_STATUSES.length); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value + WORK_STATUSES.length - 1) % WORK_STATUSES.length); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    const digit = Number(event.key);
    if (digit >= 1 && digit <= WORK_STATUSES.length) { event.preventDefault(); event.stopPropagation(); choose(WORK_STATUSES[digit - 1]!); }
  };

  return (
    <div className="wd-menu" ref={root}>
      <button ref={button} type="button" className="wd-state" aria-label="Status" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(); } }}>
        <StatusGlyph status={status} size={16} /><span>{STATUS_LABEL[status]}</span><Icon name="chevron-down" size={14} className="wd-state__go" />
      </button>
      {open ? (
        <div className="wd-menu__list" role="menu" id={menuId} aria-label="Status" onKeyDown={onMenuKey}>
          {WORK_STATUSES.map((value, index) => (
            <button key={value} ref={(node) => { items.current[index] = node; }} type="button" role="menuitemradio" aria-checked={value === status} tabIndex={index === active ? 0 : -1}
              className="wd-menu__item" onClick={() => choose(value)} onMouseMove={() => setActive(index)}>
              <StatusGlyph status={value} size={16} /><span>{STATUS_LABEL[value]}</span><kbd>{index + 1}</kbd>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The title, edited where it is read: it looks like the heading, a click or Enter makes it a field,
 * Enter or leaving it saves, Esc puts the old title back. The field stays open with the person's
 * text until the save is confirmed, so a failed save can be retried without retyping.
 */
export function TitleField({ title, editable, onSave }: { title: string; editable: boolean; onSave: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const attempted = useRef<string | null>(null);
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
    const ok = await onSave(next);
    setSaving(false);
    if (ok) { attempted.current = null; leave(); }
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
            onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))}
            onBlur={() => void save(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(false); }
              else if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); cancel(); }
            }} />
        </>
      ) : (
        <button ref={opener} type="button" className="wd-title__text" title="Edit title" onClick={() => { setDraft(title); setEditing(true); }}>{title}</button>
      )}
    </h3>
  );
}
