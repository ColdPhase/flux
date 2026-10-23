import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PersonalAssistantStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useAllAiBlocked, useBlockedWorkspaceIds } from '../ai/workspaceAi';
import { useShellData } from '../app/data';
import { SwitchRow } from '../app/SettingsHome';
import { getAssistantStatus } from './api';
import { MorningSummarySheet } from './ScheduleSheet';
import { setMorningSummary } from './scheduleApi';
import './schedules.css';

/**
 * Settings → Notifications → Morning summary, the assistant's part (F-027 AST-7): "Let your assistant write your morning summary" while the
 * person's assistant is on, or "Written by Ada's assistant · Change ›" once it does. Turning it on is the same flow as the assistant
 * screen's starter, including the note about background use the first time for an account.
 */
export function SummaryByAssistant({ byAssistant, at, onApplied }: { byAssistant: boolean; at: string; onApplied: (on: boolean) => void }) {
  const { me } = useShellData();
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState('');
  const allOff = useAllAiBlocked();
  const blocked = useBlockedWorkspaceIds();
  useEffect(() => {
    if (allOff) return undefined;
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setStatus, () => undefined);
    return () => controller.abort();
  }, [allOff]);
  // The first workspace whose AI is on (F-029, #614); with none, the row is not shown.
  const workspaceId = status?.enablement?.agents.find((agent) => !blocked.has(agent.workspaceId))?.workspaceId;
  if (allOff || !status?.enablement || !workspaceId) return null;
  const scope = { workspaceId, ownerId: me.user.id };
  const first = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  if (byAssistant) {
    return <p className="nset__assistant-summary" data-ai-surface="summary-by-assistant">Written by {first}&apos;s assistant · <Link className="ui-link" to="/settings/assistant">Change ›</Link></p>;
  }
  const turnOn = async () => {
    setError('');
    try { await setMorningSummary({ on: true }); onApplied(true); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') setSheet(true);
      else setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'That didn’t work. Nothing changed; try again.');
    }
  };
  return (
    <>
      <SwitchRow label="Let your assistant write your morning summary" checked={false} onChange={() => void turnOn()} />
      {error ? <p className="nset__error" role="alert">{error}</p> : null}
      <MorningSummarySheet open={sheet} onClose={() => setSheet(false)} scope={scope} time={at} onDone={() => onApplied(true)} />
    </>
  );
}
