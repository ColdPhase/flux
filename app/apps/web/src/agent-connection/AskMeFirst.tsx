import { useState } from 'react';
import { AGENT_MAY_DO_HINTS, type AgentMayDo } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Icon } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import { setAgentMayDo } from './api';
import './connection.css';

/**
 * "Ask me first" for one agent or local app (F-036 AG-3, founder decision #1419): one switch. Off, it makes new things and changes yours at
 * once and tells you, with Undo; on, every change waits for your OK. The switch shows only what the server kept, so a failed save leaves it.
 */
export function AskMeFirst({ connectionId, initial }: { connectionId: string; initial: AgentMayDo }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const on = value !== 'act';
  // Never disabled while it saves, so the focus stays on it; a second press waits for the first.
  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true); setError('');
    try { setValue((await setAgentMayDo(connectionId, next ? 'ask' : 'act')).mayDo); }
    catch (cause) { setError(`Couldn’t save. ${cause instanceof NetworkError ? 'Offline' : cause instanceof ApiError && cause.message ? cause.message : 'Try again.'}`); }
    finally { setSaving(false); }
  };
  return (
    <div className="ask-first" data-ask-first={on ? 'on' : 'off'}>
      <SwitchRow label="Ask me first" detail={on ? AGENT_MAY_DO_HINTS.ask : AGENT_MAY_DO_HINTS.act} checked={on} onChange={(next) => void save(next)} />
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </div>
  );
}
