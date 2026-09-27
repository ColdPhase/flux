import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { workspaceAgentsPath, type Agent, type AgentConnection, type AgentScope, type Project } from '@flux/contracts';
import { getMe } from '../api/auth';
import { ApiError, NetworkError, request as apiRequest } from '../api/client';
import { listAccessibleProjects } from '../app/conversation-api';
import { signInPath } from '../auth/logic';
import { Button, Icon } from '../ui';
import {
  SCOPE_LABELS, continueAgentOAuth, createAgentConnection, decideAgentConsent,
  followOAuthRedirect, getConsentContext, listAgentConnections, selectAgentConnection,
  type ConsentContext,
} from './api';
import './connection.css';

const ALL_SCOPES: AgentScope[] = ['flux.context.read', 'flux.proposal.write'];
const EXTRA_SCOPE_LABELS: Record<string, { title: string; description: string }> = {
  offline_access: { title: 'Stay connected', description: 'Allow the client to renew its access until you revoke the connection.' },
  openid: { title: 'Identify your Flux account', description: 'Confirm which account approved this connection.' },
  profile: { title: 'See your basic profile', description: 'Share your Flux display name with the client.' },
  email: { title: 'See your account email', description: 'Share your Flux account email with the client.' },
};

interface ConnectionData {
  connections: AgentConnection[];
  projects: Project[];
  agents: Agent[];
  ownerId: string;
  oauthQuery: string;
}

function queryFrom(request: Request) { return new URL(request.url).search.slice(1); }

async function requirePerson(request: Request) {
  const me = await getMe(request.signal);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(signInPath(`${url.pathname}${url.search}`));
  }
  return me;
}

export async function agentConnectionLoader({ request }: LoaderFunctionArgs): Promise<ConnectionData> {
  const me = await requirePerson(request);
  const [connections, accessible] = await Promise.all([
    listAgentConnections(request.signal), listAccessibleProjects(request.signal),
  ]);
  const byWorkspace = await Promise.all(accessible.workspaces.map(async (workspace) => {
    try { return await apiRequest<Agent[]>(workspaceAgentsPath(workspace.id), { signal: request.signal }); }
    catch (error) { if (error instanceof ApiError && error.status === 403) return []; throw error; }
  }));
  return {
    connections,
    projects: accessible.projects,
    agents: byWorkspace.flat().filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt),
    ownerId: me.user.id,
    oauthQuery: queryFrom(request),
  };
}

export async function agentConsentLoader({ request }: LoaderFunctionArgs): Promise<{ context: ConsentContext; oauthQuery: string }> {
  await requirePerson(request);
  const oauthQuery = queryFrom(request);
  if (!oauthQuery) throw new Response('The authorization request is missing. Start again in your agent client.', { status: 400 });
  return { context: await getConsentContext(oauthQuery, request.signal), oauthQuery };
}

function describeError(error: unknown) {
  if (error instanceof NetworkError) return 'Flux cannot be reached. Check your connection and try again.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session ended. Sign in, then start the connection again.';
    if (error.status === 403 || error.status === 404) return 'This connection or project is no longer available to you. Choose another one.';
    if (error.status === 400 || error.status === 409) return 'This authorization request is no longer valid. Start again in your agent client.';
  }
  return error instanceof Error && error.message.startsWith('Flux did not return') ? error.message : 'Something went wrong. Try again.';
}

function FlowHeader({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return <header className="connection__head">
    <span className="connection__eyebrow"><Icon name="spark" size={15} /> {step}</span>
    <h1>{title}</h1>
    <p>{children}</p>
  </header>;
}

function ScopeList({ scopes }: { scopes: string[] }) {
  return <ul className="connection__scopes">{scopes.map((scope) => {
    const detail = SCOPE_LABELS[scope as AgentScope] ?? EXTRA_SCOPE_LABELS[scope];
    return <li key={scope}>
      <Icon name="check" size={15} />
      <span><strong>{detail?.title ?? scope}</strong>{detail ? <small>{detail.description}</small> : null}</span>
    </li>;
  })}</ul>;
}

function ConnectionSummary({ connection, agentName, projectNames }: {
  connection: AgentConnection;
  agentName: string;
  projectNames: Map<string, string>;
}) {
  return <div className="connection__summary">
    <strong>{agentName}</strong>
    <span className="connection__meta">{connection.selectedProjectIds.length} {connection.selectedProjectIds.length === 1 ? 'project' : 'projects'} · {connection.scopes.length === 2 ? 'Read and propose' : connection.scopes[0] === 'flux.context.read' ? 'Read only' : 'Propose only'}</span>
    <ul className="connection__projects">{connection.selectedProjectIds.map((id) => <li key={id}>{projectNames.get(id) ?? `Project ${id.slice(0, 8)}`}</li>)}</ul>
    <ScopeList scopes={connection.scopes} />
  </div>;
}

export function AgentConnectionPage() {
  const { connections, projects, agents, oauthQuery } = useLoaderData() as ConnectionData;
  const [items, setItems] = useState(connections.filter((connection) => !connection.revokedAt));
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  const [adding, setAdding] = useState(items.length === 0);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<AgentScope[]>(ALL_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const chosenAgent = agents.find((agent) => agent.id === agentId);
  const eligibleProjects = projects.filter((project) => project.workspaceId === chosenAgent?.workspaceId);

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId || projectIds.length === 0 || scopes.length === 0) return;
    setBusy(true); setError(null);
    try {
      const connection = await createAgentConnection({ agentId, selectedProjectIds: projectIds, scopes });
      setItems((current) => [...current, connection]);
      setSelected(connection.id);
      setAdding(false);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  async function connect() {
    if (!selected || !oauthQuery) return;
    setBusy(true); setError(null);
    try {
      await selectAgentConnection(selected);
      followOAuthRedirect(await continueAgentOAuth(oauthQuery));
    } catch (cause) { setError(describeError(cause)); setBusy(false); }
  }

  return <section className="connection" aria-label="Connect an agent">
    <FlowHeader step="Agent connection · 1 of 2" title="Choose what your agent can use">
      Select your own agent and the projects it may work with. Access is checked again whenever the agent calls Flux.
    </FlowHeader>
    {!oauthQuery ? <div className="connection__alert" role="alert">Start this connection in your agent client. This page needs its authorization request.</div> : null}
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    {items.length ? <fieldset className="connection__group" disabled={busy}>
      <legend>Saved selections</legend>
      <div className="connection__choices">{items.map((connection) => <label className="connection__choice" key={connection.id}>
        <input type="radio" name="connection" value={connection.id} checked={selected === connection.id} onChange={() => setSelected(connection.id)} />
        <ConnectionSummary connection={connection} agentName={agentNames.get(connection.agentId) ?? `Agent ${connection.agentId.slice(0, 8)}`} projectNames={projectNames} />
      </label>)}</div>
    </fieldset> : null}
    {adding ? <form className="connection__create" onSubmit={(event) => { void addConnection(event); }}>
      <h2>New selection</h2>
      <p>Flux accepts only projects already granted to your agent. Saving this selection does not change project access.</p>
      <label className="connection__label" htmlFor="connection-agent">Your agent</label>
      <select id="connection-agent" value={agentId} onChange={(event) => { setAgentId(event.target.value); setProjectIds([]); }} disabled={busy} required>
        {agents.length ? agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">No personal agents available</option>}
      </select>
      <fieldset className="connection__group" disabled={busy || !agentId}>
        <legend>Projects</legend>
        <div className="connection__checks">{eligibleProjects.map((project) => <label key={project.id}>
          <input type="checkbox" checked={projectIds.includes(project.id)} onChange={(event) => setProjectIds((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} />
          <span>{project.name}</span>
        </label>)}</div>
        {!eligibleProjects.length ? <p>No projects are available in this agent’s workspace.</p> : null}
      </fieldset>
      <fieldset className="connection__group" disabled={busy || !agentId}>
        <legend>Allowed actions</legend>
        <div className="connection__checks">{ALL_SCOPES.map((scope) => <label key={scope}>
          <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} />
          <span><strong>{SCOPE_LABELS[scope].title}</strong><small>{SCOPE_LABELS[scope].description}</small></span>
        </label>)}</div>
      </fieldset>
      <div className="connection__actions"><Button type="submit" variant="secondary" busy={busy} disabled={!agentId || !projectIds.length || !scopes.length}>Save selection</Button>
        {items.length ? <Button onClick={() => setAdding(false)}>Cancel</Button> : null}</div>
      {!agents.length ? <p className="connection__help">Create a personal agent in your workspace before connecting Claude Code.</p> : null}
    </form> : <Button variant="link" onClick={() => setAdding(true)}>Create another selection</Button>}
    <div className="connection__footer">
      <Button variant="primary" size="lg" onClick={() => { void connect(); }} busy={busy} disabled={!selected || !oauthQuery}>Continue to consent</Button>
      <Link className="ui-link" to="/">Back to Flux</Link>
    </div>
  </section>;
}

export function AgentConsentPage() {
  const { context, oauthQuery } = useLoaderData() as { context: ConsentContext; oauthQuery: string };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNames = new Map(context.selectedProjects?.map((project) => [project.id, project.name]) ?? []);
  async function decide(accept: boolean) {
    setBusy(true); setError(null);
    try { followOAuthRedirect(await decideAgentConsent(accept, oauthQuery)); }
    catch (cause) { setError(describeError(cause)); setBusy(false); }
  }
  return <section className="connection" aria-label="Agent access consent">
    <FlowHeader step="Agent connection · 2 of 2" title="Review access before connecting">
      <strong>{context.clientName}</strong> is asking to connect to Flux. Check the selected projects and actions below.
    </FlowHeader>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    <ConnectionSummary connection={context.connection} agentName={context.agentName ?? `Agent ${context.connection.agentId.slice(0, 8)}`} projectNames={projectNames} />
    <div className="connection__requested">
      <h2>Requested in this authorization</h2>
      <ScopeList scopes={context.scopes} />
    </div>
    <p className="connection__help">The agent uses your Claude Code account for compute. Flux does not receive your provider credentials. You can revoke this connection in Flux; access also ends if a project grant is removed.</p>
    <div className="connection__footer">
      <Button variant="primary" size="lg" busy={busy} onClick={() => { void decide(true); }}>Allow access</Button>
      <Button size="lg" disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
    </div>
  </section>;
}
