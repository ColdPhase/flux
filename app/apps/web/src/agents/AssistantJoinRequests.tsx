import { useId, useState } from 'react';
import type { ProjectAgents } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { AgentIdentity, Button, Icon, agentHue } from '../ui';
import { allowAssistantJoin, requestAssistantJoin } from './api';
import './joins.css';

function failure(error: unknown) {
  if (error instanceof NetworkError) return 'Flux could not confirm the change. Refresh to see the current request before trying again.';
  if (error instanceof ApiError && error.status === 403) return 'Only a current project manager can allow this request.';
  if (error instanceof ApiError && error.status === 404) return 'This assistant or project is no longer available to you.';
  return 'The request could not be changed. Refresh and try again.';
}

/** P9's one Requests row, with the ordinary manager grant behind Allow. Asking starts no run. */
export function AssistantJoinRequests({ projectId, meId, meName, view, names, canManage, onRefresh }: {
  projectId: string; meId: string; meName: string | null; view: ProjectAgents;
  names: Map<string, string>; canManage: boolean; onRefresh(): Promise<void>;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requests = view.joinRequests ?? [];
  const name = (ownerId: string) => ownerId === meId ? meName ?? 'You' : names.get(ownerId) ?? 'A member';
  const assistantName = (ownerId: string) => {
    const fullName = name(ownerId);
    return `${fullName === 'A member' ? fullName : fullName.trim().split(/\s+/)[0] || fullName}’s assistant`;
  };
  const summary = requests.length === 1 ? `${assistantName(requests[0]!.ownerUserId)} asks to join` : `${requests.length} assistants ask to join`;
  const send = async () => {
    setBusy('request'); setError(null); setNotice(null);
    try {
      await requestAssistantJoin(projectId);
      setNotice('Asked a project manager to add your assistant. It has no access here yet.');
      await onRefresh();
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(null); }
  };
  const allow = async (requestId: string) => {
    setBusy(requestId); setError(null); setNotice(null);
    try {
      const result = await allowAssistantJoin(projectId, requestId);
      if (result.state !== 'accepted') throw new Error('Request is no longer pending');
      setNotice('Request allowed.');
      await onRefresh();
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(null); }
  };
  if (!requests.length && !view.assistantJoin?.canRequest && !notice && !error) return null;
  return (
    <section className="agents-join" aria-label="Assistant join requests">
      {view.assistantJoin?.canRequest ? (
        <div className="agents-join__ask">
          <span className="agents-join__ask-copy"><AgentIdentity name="Your assistant" owner={meName ?? 'you'} hue={agentHue(view.assistantJoin.agentId)} /><span>Not in this project yet. A manager can add it.</span></span>
          <Button variant="secondary" busy={busy === 'request'} disabled={busy !== null && busy !== 'request'} onClick={() => void send()}>Ask a manager to add my assistant</Button>
        </div>
      ) : null}
      {requests.length ? (
        <>
          <button type="button" className="agents-join__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
            <span className="agents-join__count" aria-hidden="true">{requests.length}</span>
            <span className="agents-join__summary"><b>{requests.length === 1 ? 'Request' : 'Requests'}</b> · {summary}</span>
            <span className="agents-join__review">{open ? 'Close' : 'Review'}<Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></span>
          </button>
          {open ? (
            <ul className="agents-join__list" id={bodyId}>
              {requests.map((row) => (
                <li key={row.id} className="agents-join__item">
                  <div className="agents-join__details">
                    <AgentIdentity className="agents-join__identity" name={assistantName(row.ownerUserId)} owner={name(row.ownerUserId)} hue={agentHue(row.agentId)} expression="asking" />
                    <p>{canManage ? 'Asks to join as a contributor. Allow gives it access within its owner’s project permissions.' : 'Waiting for a project manager. Your assistant has no access here yet.'}</p>
                  </div>
                  {canManage ? <Button variant="secondary" busy={busy === row.id} disabled={busy !== null && busy !== row.id} onClick={() => void allow(row.id)}>Allow</Button> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {notice ? <p className="agents-join__notice" role="status">{notice}</p> : null}
      {error ? <div className="agents-join__error"><p role="alert">{error}</p><Button variant="link" onClick={() => void onRefresh()}>Refresh requests</Button></div> : null}
    </section>
  );
}
