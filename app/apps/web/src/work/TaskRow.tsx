import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { WorkRowProjection, WorkStatus } from '@flux/contracts';
import { AgentIdentity, Icon, Kreska, StatusGlyph, initials } from '../ui';
import type { AgentOwners } from '../agents/owners';
import { STATUS_LABEL, isFinished, taskNumber } from './format';
import { STATE_KEYS, nextStatus, type StateTarget } from './taskState';

// A task row as drawn (F-026 S-P-Tasks): the state glyph (one tap changes the state), the title, "#number" and
// who or what it waits for, then the owner or a "Blocked" pill. Swipe left (touch or pen) reveals Done.

const ACTION = 76;
const LOCK = 8;

function meta(item: WorkRowProjection, meId: string, owners: AgentOwners) {
  const { rule, parkedBy } = item;
  const results = item.relations.results;
  const waiting = isFinished(item) ? 0 : item.prerequisiteCounts.unmet;
  const owner = item.owner;
  // An agent keeps its Agent tag and the person it works for in every state; a person with the same name does not get them.
  const who = !owner ? 'no owner'
    : owner.kind === 'agent'
      ? <AgentIdentity icon={false} name={owner.name} owner={owners.get(owner.id)} />
      : owner.id === meId ? 'you' : owner.name;
  const rest = [
    item.status === 'blocked' && item.blocker ? `waiting for ${item.blocker}` : null,
    waiting ? `waits for ${waiting} ${waiting === 1 ? 'task' : 'tasks'}` : null,
    parkedBy ? `Parked · was ${STATUS_LABEL[item.status].toLowerCase()}` : null,
    rule && !parkedBy ? `follows “${rule.title}”` : null,
    item.relations.sourceMessages > 0 ? 'from a message' : null,
    results ? `${results} ${results === 1 ? 'result' : 'results'}` : null,
  ].filter(Boolean);
  // The word for the state is part of the line, so the glyph is never alone (guide: a word always accompanies it).
  return (
    <>
      <span className="ui-task-number">{taskNumber(item)}</span>
      {' · '}{who}
      {item.parked ? null : <span className="ws-task__word">{` · ${STATUS_LABEL[item.status]}`}</span>}
      {rest.map((part) => ` · ${part}`).join('')}
    </>
  );
}

export interface TaskRowProps {
  item: WorkRowProjection;
  meId: string;
  owners: AgentOwners;
  writable: boolean;
  muted?: boolean;
  onOpen: () => void;
  onChange: (item: StateTarget, status: WorkStatus) => void;
}

export function TaskRow({ item, meId, owners, writable, muted, onOpen, onChange }: TaskRowProps) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; base: number; locked: boolean; wasOpen: boolean } | null>(null);
  const suppress = useRef(false);
  const row = useRef<HTMLLIElement>(null);
  const open = dx <= -ACTION;
  const finished = item.status === 'done';

  // A tap outside a revealed action closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: globalThis.PointerEvent) => { if (!row.current?.contains(event.target as Node)) setDx(0); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const down = (event: PointerEvent) => {
    if (!writable || event.pointerType === 'mouse' || (event.target as Element).closest('.ws-task__glyph')) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: dx, locked: false, wasOpen: open };
  };
  const move = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const mx = event.clientX - g.x;
    const my = event.clientY - g.y;
    if (!g.locked) {
      if (Math.abs(my) > LOCK && Math.abs(my) > Math.abs(mx)) { gesture.current = null; return; }
      if (Math.abs(mx) < LOCK) return;
      g.locked = true;
      setDragging(true);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    setDx(Math.max(-ACTION, Math.min(0, g.base + mx)));
  };
  const up = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    if (!g.locked) {
      // A tap on a revealed row closes it; the click that follows must not open the task.
      if (g.wasOpen) { setDx(0); suppress.current = true; window.setTimeout(() => { suppress.current = false; }, 300); }
      return;
    }
    setDragging(false);
    suppress.current = true;
    window.setTimeout(() => { suppress.current = false; }, 0);
    setDx((now) => now < -ACTION / 2 ? -ACTION : 0);
  };
  const cancel = () => { gesture.current = null; setDragging(false); setDx(0); };

  const key = (event: KeyboardEvent) => {
    const status = STATE_KEYS[event.key];
    if (!writable || !status || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    event.preventDefault();
    onChange(item, status);
  };
  const click = (event: MouseEvent) => {
    if (suppress.current) { event.preventDefault(); event.stopPropagation(); return; }
    if (open) { setDx(0); return; }
    onOpen();
  };
  const word = STATUS_LABEL[item.status];
  const label = writable ? `${word}. Set to ${STATUS_LABEL[nextStatus(item.status)]}` : word;
  return (
    <li ref={row} className={`ws-task${item.owner?.kind === 'agent' ? ' ws-task--agent' : ''}${dragging ? ' is-dragging' : ''}${open ? ' is-open' : ''}`} data-work-kind="work" data-work-id={item.id} data-status={item.status}>
      {writable && !finished ? (
        <div className="ws-task__acts">
          <button type="button" className="ws-task__done" tabIndex={open ? 0 : -1} aria-hidden={open ? undefined : true}
            onClick={() => { setDx(0); onChange(item, 'done'); }}><Icon name="check" size={18} />Done<span className="ui-vh"> {taskNumber(item)}</span></button>
        </div>
      ) : null}
      <div className="ws-task__fg" style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onKeyDown={key}>
        {writable ? (
          <button type="button" className="ws-task__glyph" aria-label={label} title={`${label} (keys 1 to 5)`} aria-keyshortcuts="1 2 3 4 5"
            onClick={() => onChange(item, nextStatus(item.status))}>
            <StatusGlyph status={item.status} className={item.parked ? 'ui-glyph--parked' : undefined} />
          </button>
        ) : <span className="ws-task__glyph ws-task__glyph--still" role="img" aria-label={word}><StatusGlyph status={item.status} /></span>}
        <button type="button" className={`ws-item${muted ? ' ws-item--muted' : ''}`} onClick={click}>
          <span className="ws-item__b"><span className="ws-item__t">{item.title}</span><span className="ws-item__s">{meta(item, meId, owners)}</span></span>
          <span className="ws-item__r">
            {item.status === 'blocked' ? <span className="ui-pill ui-pill--inv">Blocked</span>
              : item.owner?.kind === 'agent' ? <Kreska size={24} />
                : item.owner ? <span className="ws-av" aria-hidden="true">{initials(item.owner.name)}</span> : null}
          </span>
        </button>
      </div>
    </li>
  );
}
