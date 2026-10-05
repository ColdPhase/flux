import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { workspaceAgentsPath, type Agent, type AgentConnection, type AgentScope, type AgentStandingGrant, type ExternalClientDesignation, type Project, type ProjectGrant, type Workspace } from '@flux/contracts';
import { getMe } from '../api/auth';
import { ApiError, NetworkError, request as apiRequest } from '../api/client';
import { listAccessibleProjects } from '../app/conversation-api';
import { signInPath } from '../auth/logic';
import { Button, Icon } from '../ui';
import {
  SCOPE_LABELS, continueAgentOAuth, createAgentConnection, createPersonalAgent, decideAgentConsent,
  followOAuthRedirect, getConsentContext, grantAgentProject, listActionGrants, listAgentConnections, listProjectGrants,
  revokeAgentConnection, selectAgentConnection,
  type ConsentContext,
} from './api';
import { ClientGuide } from './ClientGuide';
import { StandingGrants } from './StandingGrants';
import './connection.css';

const ALL_SCOPES: AgentScope[] = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
const EXTRA_SCOPE_LABELS: Record<string, { title: string; description: string }> = {
  offline_access: { title: 'Stay connected', description: 'Allow the client to renew its access until you revoke the connection.' },
  openid: { title: 'Identify your Flux account', description: 'Confirm which account approved this connection.' },
  profile: { title: 'See your basic profile', description: 'Share your Flux display name with the client.' },
  email: { title: 'See your account email', description: 'Share your Flux account email with the client.' },
};

interface ConnectionData {
  connections: AgentConnection[];
  projects: Project[];
  workspaces: Workspace[];
  /** Only managers can inspect grants. Missing keys mean the status is unknown to this person. */
  grants: Record<string, ProjectGrant[]>;
  agents: Agent[];
  ownerId: string;
  oauthQuery: string;
  /** Each live action connection's standing grants (current and ended); null when they could not be read. */
  actionGrants: Record<string, AgentStandingGrant[] | null>;
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
  const [byWorkspace, byProject] = await Promise.all([
    Promise.all(accessible.workspaces.map(async (workspace) => {
    try { return await apiRequest<Agent[]>(workspaceAgentsPath(workspace.id), { signal: request.signal }); }
    catch (error) { if (error instanceof ApiError && error.status === 403) return []; throw error; }
    })),
    Promise.all(accessible.projects.filter((project) => project.access === 'manager').map(async (project) =>
      [project.id, await listProjectGrants(project.id, request.signal)] as const)),
  ]);
  const oauthQuery = queryFrom(request);
  // The grants are the owner's alone; the OAuth chooser does not show them.
  const actionGrants = oauthQuery ? [] : await Promise.all(connections
    .filter((connection) => !connection.revokedAt && connection.scopes.includes('flux.action.execute'))
    .map(async (connection) => {
      try { return [connection.id, await listActionGrants(connection.id, request.signal)] as const; }
      catch (error) { if (error instanceof ApiError || error instanceof NetworkError) return [connection.id, null] as const; throw error; }
    }));
  return {
    connections,
    projects: accessible.projects,
    workspaces: accessible.workspaces,
    grants: Object.fromEntries(byProject),
    agents: byWorkspace.flat().filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt),
    ownerId: me.user.id,
    oauthQuery,
    actionGrants: Object.fromEntries(actionGrants),
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
    if (error.code === 'ALREADY_SELECTED') return 'This authorization request already has a different selection. Start a new connection request in your client.';
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

function ConnectionSummary({ connection, agentName, projectNames, showScopes = true }: {
  connection: AgentConnection;
  agentName: string;
  projectNames: Map<string, string>;
  showScopes?: boolean;
}) {
  return <div className="connection__summary">
    <strong>{connection.name}</strong>
    <span className="connection__meta"><span>{agentName}</span> · Your client label: {connection.clientDesignation === 'claude_code' ? 'Claude Code' : connection.clientDesignation === 'codex' ? 'Codex' : 'External client'}</span>
    <span className="connection__meta">{connection.selectedProjectIds.length} {connection.selectedProjectIds.length === 1 ? 'project' : 'projects'} · {connection.scopes.map((scope) => scope === 'flux.context.read' ? 'Read' : scope === 'flux.proposal.write' ? 'Suggest' : 'Approved actions').join(' · ')}</span>
    <div className="connection__project-access">
      <span>Selected {connection.selectedProjectIds.length === 1 ? 'project' : 'projects'}</span>
      <ul className="connection__projects">{connection.selectedProjectIds.map((id) => <li key={id}>{projectNames.get(id) ?? `Project ${id.slice(0, 8)}`}</li>)}</ul>
    </div>
    {showScopes ? <ScopeList scopes={connection.scopes} /> : null}
  </div>;
}

export function AgentConnectionPage() {
  const { connections, projects, workspaces, agents, grants, oauthQuery, actionGrants } = useLoaderData() as ConnectionData;
  const [items, setItems] = useState(connections.filter((connection) => !connection.revokedAt));
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  const [adding, setAdding] = useState(items.length === 0);
  const [personalAgents, setPersonalAgents] = useState(agents);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [creatingAgent, setCreatingAgent] = useState(agents.length === 0);
  const [agentName, setAgentName] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [clientDesignation, setClientDesignation] = useState<ExternalClientDesignation>('other');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [currentGrants, setCurrentGrants] = useState(grants);
  const [grantRoles, setGrantRoles] = useState<Record<string, 'viewer' | 'contributor'>>({});
  const [revoking, setRevoking] = useState<string | null>(null);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<AgentScope[]>(['flux.context.read', 'flux.proposal.write']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const agentNames = new Map(personalAgents.map((agent) => [agent.id, agent.name]));
  const chosenAgent = personalAgents.find((agent) => agent.id === agentId);
  const eligibleProjects = projects.filter((project) => project.workspaceId === chosenAgent?.workspaceId);

  function grantFor(project: Project) {
    return currentGrants[project.id]?.find((grant) => grant.principal.kind === 'agent' && grant.principal.id === agentId);
  }

  function canSelect(project: Project) {
    if (!currentGrants[project.id]) return true; // A non-manager cannot inspect grants; the server validates on save.
    const role = grantFor(project)?.role;
    return role === 'contributor' || (role === 'viewer' && !scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute'));
  }

  async function addPersonalAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !agentName.trim()) return;
    setBusy(true); setError(null);
    try {
      const agent = await createPersonalAgent(workspaceId, agentName.trim());
      setPersonalAgents((current) => [...current, agent]);
      setAgentId(agent.id); setProjectIds([]); setAgentName(''); setCreatingAgent(false); setAdding(true);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  async function grantProject(project: Project) {
    if (!agentId) return;
    setBusy(true); setError(null);
    try {
      const grant = await grantAgentProject(project.id, agentId, grantRoles[project.id] ?? (scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute') ? 'contributor' : 'viewer'));
      setCurrentGrants((current) => ({ ...current, [project.id]: [...(current[project.id] ?? []).filter((item) => !(item.principal.kind === 'agent' && item.principal.id === agentId)), grant] }));
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  async function revoke(connectionId: string) {
    setBusy(true); setError(null);
    try {
      await revokeAgentConnection(connectionId);
      const remaining = items.filter((item) => item.id !== connectionId);
      setItems(remaining); setSelected((current) => current === connectionId ? remaining[0]?.id ?? null : current);
      setRevoking(null);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId || !connectionName.trim() || projectIds.length === 0 || scopes.length === 0) return;
    setBusy(true); setError(null);
    try {
      const connection = await createAgentConnection({ agentId, name: connectionName.trim(), clientDesignation, selectedProjectIds: projectIds, scopes });
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
      await selectAgentConnection(selected, oauthQuery);
      followOAuthRedirect(await continueAgentOAuth(oauthQuery));
    } catch (cause) { setError(describeError(cause)); setBusy(false); }
  }

  return <section className="connection" aria-label="Connect an agent">
    <FlowHeader step={oauthQuery ? 'Agent connection · 1 of 2' : 'Personal agent access'} title={oauthQuery ? 'Choose what your agent can use' : 'Your agent connections'}>
      Select your own agent and its permitted projects. Access is checked again whenever the agent calls Flux.
    </FlowHeader>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    {items.length ? <fieldset className="connection__group" disabled={busy}>
      <legend>Saved selections</legend>
      <div className="connection__choices">{items.map((connection) => <div className="connection__saved" key={connection.id}>
        <label className="connection__choice"><input type="radio" name="connection" value={connection.id} checked={selected === connection.id} onChange={() => setSelected(connection.id)} />
          <ConnectionSummary connection={connection} agentName={agentNames.get(connection.agentId) ?? `Agent ${connection.agentId.slice(0, 8)}`} projectNames={projectNames} />
        </label>
        {revoking === connection.id ? <div className="connection__revoke"><span>Revoke this connection now? Its tools will stop working.</span>
          <Button variant="secondary" onClick={() => { void revoke(connection.id); }}>Revoke now</Button>
          <Button variant="link" onClick={() => setRevoking(null)}>Cancel</Button></div>
          : <Button variant="link" onClick={() => setRevoking(connection.id)}>Revoke connection</Button>}
        {!oauthQuery ? <StandingGrants connection={connection} projects={projectsById} initial={actionGrants[connection.id] ?? null} /> : null}
      </div>)}</div>
    </fieldset> : null}
    {creatingAgent ? <form className="connection__create" onSubmit={(event) => { void addPersonalAgent(event); }}>
      <h2>Create your personal agent</h2><p>This identity belongs only to you. A project manager must explicitly grant it project access.</p>
      {!workspaces.length ? <p className="connection__help" role="note">Your agent belongs to a workspace, and you are not in one yet. <Link to="/projects/new">Create a project</Link> to start one, or ask someone to add you to theirs.</p> : <>
      <label className="connection__label" htmlFor="agent-workspace">Workspace</label>
      <select id="agent-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy} required>
        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
      <label className="connection__label" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={160} disabled={busy} required placeholder="My research agent" />
      <div className="connection__actions"><Button type="submit" variant="secondary" busy={busy} disabled={!workspaceId || !agentName.trim()}>Create personal agent</Button>
        {personalAgents.length ? <Button onClick={() => setCreatingAgent(false)}>Cancel</Button> : null}</div>
      </>}
    </form> : <Button variant="link" onClick={() => setCreatingAgent(true)}>Create personal agent</Button>}
    {!oauthQuery ? <ClientGuide origin={window.location.origin} /> : null}
    {personalAgents.length > 0 && adding ? <form className="connection__create" onSubmit={(event) => { void addConnection(event); }}>
      <h2>New connection</h2>
      <label className="connection__label" htmlFor="connection-name">Connection name</label>
      <input id="connection-name" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} maxLength={120} disabled={busy} required placeholder="Research laptop" />
      <label className="connection__label" htmlFor="connection-client">Client label</label>
      <select id="connection-client" value={clientDesignation} onChange={(event) => setClientDesignation(event.target.value as ExternalClientDesignation)} disabled={busy}>
        <option value="other">External client</option><option value="claude_code">Claude Code</option><option value="codex">Codex</option>
      </select>
      <p>This label helps you recognize the connection. It does not verify which application uses it.</p>
      <p>Flux accepts only projects already granted to your agent. Saving this selection does not change project access.</p>
      <label className="connection__label" htmlFor="connection-agent">Your agent</label>
      <select id="connection-agent" value={agentId} onChange={(event) => { setAgentId(event.target.value); setProjectIds([]); }} disabled={busy} required>
        {personalAgents.length ? personalAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">Create a personal agent first</option>}
      </select>
      <fieldset className="connection__group" disabled={busy || !agentId}>
        <legend>Projects</legend>
        <div className="connection__checks">{eligibleProjects.map((project) => {
          const role = grantFor(project)?.role;
          const selectable = canSelect(project);
          return <div className="connection__project" key={project.id}><label>
            <input type="checkbox" disabled={!selectable || (projectIds.length >= 50 && !projectIds.includes(project.id))} checked={projectIds.includes(project.id) && selectable} onChange={(event) => setProjectIds((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} />
            <span><strong>{project.name}</strong><small>{currentGrants[project.id]
              ? role === 'contributor' ? 'Agent grant: read and propose' : role === 'viewer' ? 'Agent grant: read only' : role === 'denied' ? 'Agent access denied' : 'No agent grant yet'
              : 'Ask a project manager to confirm this agent’s grant before saving.'}</small></span>
          </label>
          {project.access === 'manager' && !selectable ? <div className="connection__grant">
            <label htmlFor={`grant-${project.id}`}>Grant agent access</label>
            <select id={`grant-${project.id}`} value={grantRoles[project.id] ?? (scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute') ? 'contributor' : 'viewer')} onChange={(event) => setGrantRoles((current) => ({ ...current, [project.id]: event.target.value as 'viewer' | 'contributor' }))} disabled={busy}>
              <option value="viewer">Read only</option><option value="contributor">Read and propose</option>
            </select>
            <Button variant="secondary" onClick={() => { void grantProject(project); }}>Grant</Button>
          </div> : null}</div>;
        })}</div>
        {projectIds.length >= 50 ? <p>One selection can include up to 50 projects.</p> : null}
        {!eligibleProjects.length ? <p>No projects are available in this agent’s workspace.</p> : null}
      </fieldset>
      <fieldset className="connection__group" disabled={busy || !agentId}>
        <legend>Allowed actions</legend>
        <div className="connection__checks">{ALL_SCOPES.map((scope) => <label key={scope}>
          <input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => {
            setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope));
            if ((scope === 'flux.proposal.write' || scope === 'flux.action.execute') && event.target.checked) setProjectIds((current) => current.filter((id) => {
              const project = eligibleProjects.find((item) => item.id === id);
              return project && (!currentGrants[id] || grantFor(project)?.role === 'contributor');
            }));
          }} />
          <span><strong>{SCOPE_LABELS[scope].title}</strong><small>{SCOPE_LABELS[scope].description}</small></span>
        </label>)}</div>
      </fieldset>
      <div className="connection__actions"><Button type="submit" variant="secondary" busy={busy} disabled={!agentId || !connectionName.trim() || !projectIds.length || !scopes.length}>Save connection</Button>
        {items.length ? <Button onClick={() => setAdding(false)}>Cancel</Button> : null}</div>
    </form> : personalAgents.length ? <Button variant="link" onClick={() => setAdding(true)}>Create another selection</Button> : null}
    <div className="connection__footer">
      {oauthQuery ? <Button variant="primary" size="lg" onClick={() => { void connect(); }} busy={busy} disabled={!selected}>Continue to consent</Button> : null}
      <Link className="ui-link" to="/">Back to Flux</Link>
    </div>
  </section>;
}

export function AgentConsentPage() {
  const { context, oauthQuery } = useLoaderData() as { context: ConsentContext; oauthQuery: string };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNames = new Map(context.selectedProjects?.map((project) => [project.id, project.name]) ?? []);
  const requestedProjectActions = context.scopes.filter((scope) => ALL_SCOPES.includes(scope as AgentScope));
  const projectActionsMatch = requestedProjectActions.length === context.connection.scopes.length
    && context.connection.scopes.every((scope) => requestedProjectActions.includes(scope));
  async function decide(accept: boolean) {
    setBusy(true); setError(null);
    try { followOAuthRedirect(await decideAgentConsent(accept, oauthQuery)); }
    catch (cause) { setError(describeError(cause)); setBusy(false); }
  }
  return <section className="connection connection--consent" aria-label="Agent access consent">
    <FlowHeader step="Agent connection · 2 of 2" title="Review access before connecting">
      <strong>{context.clientName}</strong> is asking to connect to Flux. Check the selected projects and actions below.
    </FlowHeader>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    <ConnectionSummary connection={context.connection} agentName={context.agentName ?? `Agent ${context.connection.agentId.slice(0, 8)}`} projectNames={projectNames} showScopes={false} />
    <div className="connection__requested">
      <h2>Requested by this client</h2>
      <p>{projectActionsMatch ? 'The requested project actions match your saved selection.' : 'This client requests fewer project actions than your saved selection.'} Approval does not add projects or agent grants.</p>
      <ScopeList scopes={context.scopes} />
    </div>
    <p className="connection__help">Your external client handles compute. Flux does not receive provider credentials or verify how the client is billed. You can revoke this connection in Flux; access also ends if a project grant is removed.</p>
    <div className="connection__footer">
      <Button variant="primary" size="lg" busy={busy} onClick={() => { void decide(true); }}>Allow access</Button>
      <Button size="lg" disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
    </div>
  </section>;
}
