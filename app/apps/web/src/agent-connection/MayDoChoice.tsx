import { useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_MAY_DO, AGENT_MAY_DO_HINTS, AGENT_MAY_DO_LABELS, type AgentMayDo } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Icon } from '../ui';
import { setAgentMayDo } from './api';
import './connection.css';

/**
 * "What it may do" for one agent (F-036 AG-3): Only read, Do it and tell me or Ask me first, as one radio group with arrow keys.
 * The selection is only ever what the server kept, so a failed save leaves it, and focus, where they were.
 */
export function MayDoChoice({ connectionId, initial, label, labelledBy }: { connectionId: string; initial: AgentMayDo; label?: string; labelledBy?: string }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const group = useRef<HTMLDivElement>(null);
  const save = async (next: AgentMayDo) => {
    setSaving(true); setError('');
    try { setValue((await setAgentMayDo(connectionId, next)).mayDo); return next; }
    catch (cause) {
      setError(`Couldn’t save. ${cause instanceof NetworkError ? 'Offline' : cause instanceof ApiError && cause.message ? cause.message : 'Try again.'}`);
      return value;
    } finally { setSaving(false); }
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = AGENT_MAY_DO[(AGENT_MAY_DO.indexOf(value) + delta + AGENT_MAY_DO.length) % AGENT_MAY_DO.length]!;
    void save(next).then((kept) => requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-may-do="${kept}"]`)?.focus()));
  };
  return (
    <>
      <div ref={group} className="seg may-do" role="radiogroup" aria-label={label} aria-labelledby={labelledBy} onKeyDown={move}>
        {AGENT_MAY_DO.map((choice) => (
          <button key={choice} type="button" role="radio" className="seg__b" data-may-do={choice} aria-checked={value === choice} disabled={saving}
            tabIndex={value === choice ? 0 : -1} onClick={() => { if (value !== choice) void save(choice); }}>{AGENT_MAY_DO_LABELS[choice]}</button>
        ))}
      </div>
      <span className="may-do__hint">{AGENT_MAY_DO_HINTS[value]}</span>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </>
  );
}
