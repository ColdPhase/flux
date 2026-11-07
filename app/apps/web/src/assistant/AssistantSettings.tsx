import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { PersonalAssistantStatus } from '@flux/contracts';
import { useShellData } from '../app/data';
import { Icon, Spinner } from '../ui';
import { getAssistantStatus } from './api';
import '../notifications/notifications.css';
import './assistant.css';
import { AssistantReactions } from './AssistantReactions';
import { AssistantSchedules } from './AssistantSchedules';

// Assistant's schedules and reactions (F-027 A8, A9). Everything else about an agent, Assistant included, is its page in
// Settings › AI (F-036 AG-1, #857). #858 moves schedules into Assistant's conversation and removes reactions, and this page goes.

export function AssistantSettings() {
  const { me, agents } = useShellData();
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setStatus, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  const first = agents[0];
  return (
    <div className="pane-scroll"><div className="pane-in nset aset">
      <div className="inbox__head"><div>
        <h2>{first ? `${first.name}’s schedules` : 'Schedules'}</h2>
        <p>Work it does on its own, at the times you choose.</p>
      </div></div>
      {failed ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />This could not load. Try again.</p> : null}
      {!status && !failed ? <p className="inbox__loading"><Spinner label="Loading schedules" /></p> : null}
      {status?.enablement ? <>
        <AssistantSchedules status={status} userId={me.user.id} />
        <AssistantReactions status={status} userId={me.user.id} />
      </> : null}
      {status && !status.enablement ? <p className="nset__note">Connect AI first, so you have an agent. <Link className="ui-link" to="/settings/agents">Back to AI</Link></p> : null}
      <p className="nset__note">{first ? <Link className="ui-link" to={`/settings/agents/${first.id}`}>Back to {first.name}</Link> : <Link className="ui-link" to="/settings/agents">Back to AI</Link>}</p>
    </div></div>
  );
}
