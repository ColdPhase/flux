import { useEffect, useState } from 'react';
import type { AgentAccessRequest, Project } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { answerAgentAccessRequest, listAgentAccessRequests } from '../agent-connection/api';
import { Button, Icon, Kreska, agentHue } from '../ui';
import { firstName } from './api';

function problem(error: unknown) {
  if (error instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again in a moment.';
  if (error instanceof ApiError && error.status === 403) return 'Only a manager of this project can answer this request.';
  if (error instanceof ApiError && error.status === 404) return 'This request or agent is no longer here.';
  return 'That didn’t work. Nothing changed; try again.';
}

/**
 * Agents asking to join a project (#763 FT-1). A person asks from Connect for their own agent; the project's managers
 * see each request here with Allow (the ordinary agent grant, still capped at the owner's own access) and Decline.
 * The owner sees their own request waiting. Nothing is granted without a manager's Allow.
 */
export function AgentRequests({ project, onChanged }: { project: Project; onChanged: (message: string) => void }) {
  const manager = project.access === 'manager';
  const [requests, setRequests] = useState<AgentAccessRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listAgentAccessRequests(project.id, controller.signal).then(setRequests, () => { if (!controller.signal.aborted) setRequests([]); });
    return () => controller.abort();
  }, [project.id, reload]);
  if (!requests?.length) return error ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{error}</p> : null;
  const answer = async (request: AgentAccessRequest, allow: boolean) => {
    setBusy(request.id); setError('');
    try {
      await answerAgentAccessRequest(project.id, request.id, allow);
      onChanged(allow ? `${request.agent.name} can now ${request.role === 'contributor' ? 'work' : 'read'} in ${project.name}.` : `${request.agent.name} was not let in.`);
      setReload((n) => n + 1);
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(null); }
  };
  return (
    <div className="access__requests" data-agent-requests="">
      <h4 className="access__sub" id={`agent-requests-${project.id}`}>{manager ? 'Agents asking to join' : 'Waiting for a manager'}</h4>
      <ul className="people__list" aria-labelledby={`agent-requests-${project.id}`}>
        {requests.map((request) => (
          <li key={request.id} className="people__item" data-agent-request={request.id}>
            <div className="people__row">
              <Kreska size={26} expression="asking" hue={agentHue(request.agent.id)} />
              <span className="people__who"><b>{request.agent.name}</b>
                <span>{manager ? `${firstName(request.owner.name)}’s agent · would ${request.role === 'contributor' ? 'read and write' : 'only read'}, never beyond what ${firstName(request.owner.name)} can do`
                  : 'Your agent · a project manager decides'}</span></span>
              {manager ? <span className="access__answer">
                <Button variant="secondary" busy={busy === request.id} disabled={busy !== null} onClick={() => void answer(request, true)}>Allow</Button>
                <Button variant="quiet" disabled={busy !== null} onClick={() => void answer(request, false)}>Decline<span className="ui-vh"> {request.agent.name}</span></Button>
              </span> : null}
            </div>
          </li>
        ))}
      </ul>
      {error ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{error}</p> : null}
    </div>
  );
}
