import { useState, type FormEvent, type ReactNode } from 'react';
import { isAiBlocked } from '../ai/workspaceAi';
import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { workspaceAgentsPath, type Agent, type AgentConnection, type AgentScope, type AgentStandingGrant, type ExternalClientDesignation, type Project, type ProjectGrant, type Workspace } from '@flux/contracts';
import { getMe } from '../api/auth';
import { ApiError, NetworkError, request as apiRequest } from '../api/client';
import { listAccessibleProjects } from '../project/api';
import { signInPath } from '../auth/logic';
import { Button, Icon, Select, Option } from '../ui';
import {
  SCOPE_LABELS, continueAgentOAuth, getOauthRequester, createAgentConnection, createPersonalAgent, decideAgentConsent,
  followOAuthRedirect, getConsentContext, grantAgentProject, listActionGrants, listAgentConnections, listProjectGrants,
  revokeAgentConnection, selectAgentConnection,
  type ConsentContext,
} from './api';
import { ClientGuide } from './ClientGuide';
import { StandingGrants } from './StandingGrants';
import { McpPermissions } from './McpPermissions';
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
  /** The connection this client held before it had to authorize again; chosen first (F-024 S2, #312). */
  heldConnectionId: string | null;
  /** The client label the asking client's own name suggests, for a new connection (#763 AG-6). */
  requesterClient: ExternalClientDesignation | null;
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

/** Settings → Agents and AI → Connect your agent: where a person manages their connections inside the app (#763 AG-2). */
export const CONNECT_AGENT_SETTINGS = '/settings/agents/connect';

/**
 * `/connect-agent`: an agent client's sign-in arrives here with its signed OAuth query and stays in the quiet frame. Without
 * one, the person came to manage their connections, which happens in Settings (#763 AG-2).
 */
export async function agentConnectionEntryLoader(args: LoaderFunctionArgs): Promise<ConnectionData> {
  if (!queryFrom(args.request)) throw redirect(CONNECT_AGENT_SETTINGS);
  return agentConnectionLoader(args);
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
  const requester = oauthQuery ? await getOauthRequester(oauthQuery, request.signal) : { connectionId: null, clientDesignation: null };
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
    // F-029 (#614): an agent of a workspace whose AI is off cannot be connected there, so it is not offered.
    agents: byWorkspace.flat().filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt
      && accessible.workspaces.find((workspace) => workspace.id === agent.workspaceId)?.ai?.state !== 'blocked'),
    ownerId: me.user.id,
    oauthQuery,
    // A held connection of a workspace whose AI is off is refused (F-029, #614): nothing is held then.
    heldConnectionId: requester.connectionId,
    requesterClient: requester.clientDesignation,
    actionGrants: Object.fromEntries(actionGrants),
  };
}

export async function agentConsentLoader({ request }: LoaderFunctionArgs): Promise<{ context: ConsentContext | null; oauthQuery: string }> {
  await requirePerson(request);
  const oauthQuery = queryFrom(request);
  if (!oauthQuery) throw new Response('The authorization request is missing. Start again in your agent client.', { status: 400 });
  // The connection's workspace has AI off (F-029, #614): the client is not asked for consent, and the page says why.
  const context = await getConsentContext(oauthQuery, request.signal).catch((error: unknown) => (isAiBlocked(error) ? null : Promise.reject(error)));
  return { context, oauthQuery };
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
  const { connections, projects, workspaces: everyWorkspace, agents, grants, oauthQuery, heldConnectionId, requesterClient, actionGrants } = useLoaderData() as ConnectionData;
  // F-029 (#614): a workspace whose AI is off is named once and not offered; its other work is unaffected.
  const aiOffSpaces = everyWorkspace.filter((workspace) => workspace.ai?.state === 'blocked');
  const workspaces = everyWorkspace.filter((workspace) => workspace.ai?.state !== 'blocked');
  // A client authorizing against a workspace whose AI is off cannot pick that connection (the server refuses it).
  const [items, setItems] = useState(connections.filter((connection) => !connection.revokedAt && (!oauthQuery || agents.some((agent) => agent.id === connection.agentId))));
  const [ended, setEnded] = useState(connections.filter((connection) => connection.revokedAt));
  const [selected, setSelected] = useState<string | null>((items.find((item) => item.id === heldConnectionId) ?? items[0])?.id ?? null);
  const [adding, setAdding] = useState(items.length === 0);
  const [personalAgents, setPersonalAgents] = useState(agents);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [creatingAgent, setCreatingAgent] = useState(agents.length === 0);
  const [agentName, setAgentName] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [clientDesignation, setClientDesignation] = useState<ExternalClientDesignation>(requesterClient ?? 'other');
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
  const eligibleProjects = projects.filter((project) => project.workspaceId === chosenAgent?.workspaceId && !aiOffSpaces.some((space) => space.id === project.workspaceId));

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
      const revoked = items.find((item) => item.id === connectionId);
      if (revoked) setEnded((current) => [{ ...revoked, revokedAt: new Date().toISOString() }, ...current]);
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

  // During a client's sign-in there is one way on (#763 AG-6): Continue saves the new connection first when its form is open.
  const formOpen = personalAgents.length > 0 && adding;
  const formReady = formOpen && !!agentId && !!connectionName.trim() && projectIds.length > 0 && scopes.length > 0;
  async function connect() {
    if (!oauthQuery || (formOpen ? !formReady : !selected)) return;
    setBusy(true); setError(null);
    try {
      let chosen = selected;
      if (formOpen) {
        const connection = await createAgentConnection({ agentId, name: connectionName.trim(), clientDesignation, selectedProjectIds: projectIds, scopes });
        setItems((current) => [...current, connection]);
        setSelected(connection.id);
        setAdding(false);
        chosen = connection.id;
      }
      await selectAgentConnection(chosen!, oauthQuery);
      followOAuthRedirect(await continueAgentOAuth(oauthQuery));
    } catch (cause) { setError(describeError(cause)); setBusy(false); }
  }

  return <section className="connection" aria-label="Connect an agent">
    <FlowHeader step={oauthQuery ? 'Agent connection · 1 of 2' : 'Personal agent access'} title={oauthQuery ? 'Choose what your agent can use' : 'Your agent connections'}>
      Select your own agent and its permitted projects. Access is checked again whenever the agent calls Flux.
    </FlowHeader>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    {aiOffSpaces.length ? <div className="connection__help" role="note" data-ai-off="">
      {aiOffSpaces.map((space) => <p key={space.id}><strong>AI is off in {space.name}.</strong> Its admins turned off agents and assistants there, so nothing can be connected to it. Everything else works as usual.</p>)}
      {!workspaces.length ? <p><Link to="/">Back to Flux</Link></p> : null}
    </div> : null}
    {items.length ? <fieldset className="connection__group" disabled={busy}>
      <legend>Saved selections</legend>
      <div className="connection__choices">{items.map((connection) => <div className="connection__saved" key={connection.id}>
        <label className="connection__choice"><input type="radio" name="connection" value={connection.id} checked={selected === connection.id} onChange={() => setSelected(connection.id)} />
          <ConnectionSummary connection={connection} agentName={agentNames.get(connection.agentId) ?? `Agent ${connection.agentId.slice(0, 8)}`} projectNames={projectNames} />
        </label>
        {!oauthQuery ? <StandingGrants connection={connection} projects={projectsById} initial={actionGrants[connection.id] ?? null} /> : null}
        {/* Revoking is managed in Settings, not on a client's way to consent (#763 AG-6). */}
        {oauthQuery ? null : revoking === connection.id ? <div className="connection__revoke"><span>Revoke this connection now? Its tools will stop working.</span>
          <Button variant="secondary" onClick={() => { void revoke(connection.id); }}>Revoke now</Button>
          <Button variant="link" onClick={() => setRevoking(null)}>Cancel</Button></div>
          : <Button variant="link" onClick={() => setRevoking(connection.id)}>Revoke connection</Button>}
      </div>)}</div>
    </fieldset> : null}
    {!oauthQuery && selected && items.some((item) => item.id === selected) ?
      <McpPermissions key={selected} connection={items.find((item) => item.id === selected)!} projectNames={projectNames} /> : null}
    {!oauthQuery && ended.length ? <details className="connection__history">
      <summary>Revoked connections ({ended.length})</summary>
      <p>These connections cannot reconnect. Create a new selection and authorize it separately; previous tasks and checkpoints remain in their projects.</p>
      <ul>{ended.map((connection) => <li key={connection.id}><strong>{connection.name}</strong><span>Revoked</span></li>)}</ul>
    </details> : null}
    {creatingAgent ? <form className="connection__create" onSubmit={(event) => { void addPersonalAgent(event); }}>
      <h2>Create your personal agent</h2><p>This identity belongs only to you. A project manager must explicitly grant it project access.</p>
      {!workspaces.length ? <p className="connection__help" role="note">Your agent belongs to a workspace, and you are not in one yet. <Link to="/projects/new">Create a project</Link> to start one, or ask someone to add you to theirs.</p> : <>
      <label className="connection__label" htmlFor="agent-workspace">Workspace</label>
      <Select id="agent-workspace" value={workspaceId} onChange={(next) => setWorkspaceId(next)} disabled={busy} required>
        {workspaces.map((workspace) => <Option key={workspace.id} value={workspace.id}>{workspace.name}</Option>)}
      </Select>
      <label className="connection__label" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={160} disabled={busy} required placeholder="My research agent" />
      <div className="connection__actions"><Button type="submit" variant="secondary" busy={busy} disabled={!workspaceId || !agentName.trim()}>Create personal agent</Button>
        {personalAgents.length ? <Button onClick={() => setCreatingAgent(false)}>Cancel</Button> : null}</div>
      </>}
    </form> : <Button variant="link" onClick={() => setCreatingAgent(true)}>Create personal agent</Button>}
    {!oauthQuery ? <ClientGuide origin={window.location.origin} /> : null}
    {personalAgents.length > 0 && adding ? <form className="connection__create" onSubmit={(event) => { if (oauthQuery) { event.preventDefault(); void connect(); } else void addConnection(event); }}>
      <h2>New connection</h2>
      <label className="connection__label" htmlFor="connection-name">Connection name</label>
      <input id="connection-name" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} maxLength={120} disabled={busy} required placeholder="Research laptop" />
      <label className="connection__label" htmlFor="connection-client">Client label</label>
      <Select id="connection-client" value={clientDesignation} onChange={(next) => setClientDesignation(next as ExternalClientDesignation)} disabled={busy}>
        <Option value="other">External client</Option><Option value="claude_code">Claude Code</Option><Option value="codex">Codex</Option>
      </Select>
      <p>This label helps you recognize the connection. It does not verify which application uses it.</p>
      <p>Flux accepts only projects already granted to your agent. Saving this selection does not change project access.</p>
      <label className="connection__label" htmlFor="connection-agent">Your agent</label>
      <Select id="connection-agent" value={agentId} onChange={(next) => { setAgentId(next); setProjectIds([]); }} disabled={busy} required>
        {personalAgents.length ? personalAgents.map((agent) => <Option key={agent.id} value={agent.id}>{agent.name}</Option>) : <Option value="">Create a personal agent first</Option>}
      </Select>
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
            <Select id={`grant-${project.id}`} value={grantRoles[project.id] ?? (scopes.some((scope) => scope === 'flux.proposal.write' || scope === 'flux.action.execute') ? 'contributor' : 'viewer')} onChange={(next) => setGrantRoles((current) => ({ ...current, [project.id]: next as 'viewer' | 'contributor' }))} disabled={busy}>
              <Option value="viewer">Read only</Option><Option value="contributor">Read and propose</Option>
            </Select>
            <Button variant="secondary" onClick={() => { void grantProject(project); }}>Grant</Button>
          </div> : null}</div>;
        })}</div>
        {projectIds.length >= 50 ? <p>One selection can include up to 50 projects.</p> : null}
        {!eligibleProjects.length ? <p>No projects are available in this agent’s workspace.</p> : null}
      </fieldset>
      <fieldset className="connection__group" disabled={busy || !agentId}>
        <legend>Allowed actions</legend>
        <p className="connection__help">You can grant fewer permissions than an agent asks for. It gets only the ones ticked here, and anything else it tries is refused.</p>
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
      <div className="connection__actions">{oauthQuery ? null : <Button type="submit" variant="secondary" busy={busy} disabled={!agentId || !connectionName.trim() || !projectIds.length || !scopes.length}>Save connection</Button>}
        {items.length ? <Button onClick={() => setAdding(false)}>{oauthQuery ? 'Use a saved connection' : 'Cancel'}</Button> : null}</div>
    </form> : personalAgents.length ? <Button variant="link" onClick={() => setAdding(true)}>Create another selection</Button> : null}
    <div className="connection__footer">
      {oauthQuery ? <Button variant="primary" size="lg" onClick={() => { void connect(); }} busy={busy} disabled={formOpen ? !formReady : !selected}>Continue to consent</Button> : null}
      {oauthQuery ? <Link className="ui-link" to="/">Back to Flux</Link> : null}
    </div>
  </section>;
}

/** The same page inside Settings, with the way back first on the left as on every Settings sub-page (Spokój). */
export function AgentConnectionSettings() {
  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in connection-settings" data-shift>
        <Link className="connection-settings__back" to="/settings/agents"><Icon name="chevron-left" size={14} />Agents and AI</Link>
        <AgentConnectionPage />
      </div>
    </div>
  );
}

/** Where an approved request goes (#287): the redirect host, the client_id host and a warning off this computer. */
function ConsentDestination({ context }: { context: ConsentContext }) {
  const { redirect, clientIdHost } = context;
  return <section className="connection__destination" aria-labelledby="consent-destination">
    <h2 id="consent-destination">Where access goes</h2>
    <dl>
      <div><dt>Sends access to</dt><dd className="connection__host">{redirect.host}</dd></div>
      <div><dt>Client details from</dt>{clientIdHost
        ? <dd className="connection__host">{clientIdHost}</dd>
        : <dd>Registered on this Flux server</dd>}</div>
    </dl>
    {redirect.kind === 'loopback'
      ? <p>This address is on your own computer, where your agent client runs.{clientIdHost
        ? <> Access goes to a program on this computer that names itself as the client at <strong>{clientIdHost}</strong>; Flux cannot check that claim.</>
        : null}</p>
      : <p className="connection__warning" role="note">
        <Icon name="alert" size={16} />
        {redirect.kind === 'app'
          ? <span><strong>This access goes to an app link.</strong> Flux will hand it to whichever app on this device opens that link. Allow only if you set up this client and trust that app.</span>
          : <span><strong>This address is not on your computer.</strong> Flux will send access to {redirect.host}, and whoever controls that address can use this connection. Allow only if you set up this client and trust that address.</span>}
      </p>}
  </section>;
}

export function AgentConsentPage() {
  const { context, oauthQuery } = useLoaderData() as { context: ConsentContext | null; oauthQuery: string };
  if (!context) return <ConsentAiOff />;
  return <ConsentReview context={context} oauthQuery={oauthQuery} />;
}

/** The consent page for a connection whose workspace has AI off: nothing is asked of the person and nothing is granted. */
function ConsentAiOff() {
  return <section className="connection connection--consent" aria-label="Agent access consent" data-ai-off="">
    <FlowHeader step="Agent connection" title="AI is off in this workspace">
      Its admins turned off agents and assistants there, so this client cannot connect to it. Everything else works as usual.
    </FlowHeader>
    <div className="connection__footer"><Link className="ui-btn ui-btn--secondary ui-btn--lg" to="/">Back to Flux</Link></div>
  </section>;
}

function ConsentReview({ context, oauthQuery }: { context: ConsentContext; oauthQuery: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNames = new Map(context.selectedProjects?.map((project) => [project.id, project.name]) ?? []);
  const notGranted = context.notGranted ?? [];
  async function decide(accept: boolean) {
    setBusy(true); setError(null);
    try { followOAuthRedirect(await decideAgentConsent(accept, oauthQuery, context.scopes)); }
    catch (cause) { setError(describeError(cause)); setBusy(false); }
  }
  return <section className="connection connection--consent" aria-label="Agent access consent">
    <FlowHeader step="Agent connection · 2 of 2" title="Review access before connecting">
      <strong>{context.clientName}</strong> is asking to connect to Flux. Check where access goes, the selected projects and the actions below.
    </FlowHeader>
    {error ? <div className="connection__alert" role="alert">{error}</div> : null}
    <ConsentDestination context={context} />
    <ConnectionSummary connection={context.connection} agentName={context.agentName ?? `Agent ${context.connection.agentId.slice(0, 8)}`} projectNames={projectNames} showScopes={false} />
    <div className="connection__requested">
      <h2>This client will be allowed</h2>
      <p>{notGranted.length ? 'You can grant fewer permissions than a client asks for. It gets only the ones below, and the rest are refused.' : 'These are the permissions this connection has.'} Approval does not add projects or agent grants.</p>
      <ScopeList scopes={context.scopes} />
      {notGranted.length ? <>
        <p className="connection__help" data-testid="not-granted">Asked for, not granted:</p>
        <ul className="connection__scopes">{notGranted.map((scope) => <li key={scope}><span><strong>{SCOPE_LABELS[scope as AgentScope]?.title ?? scope}</strong></span></li>)}</ul>
      </> : null}
    </div>
    <p className="connection__help">Your external client handles compute. Flux does not receive provider credentials or verify how the client is billed. You can revoke this connection in Flux; access also ends if a project grant is removed.</p>
    <div className="connection__footer">
      <Button variant="primary" size="lg" busy={busy} onClick={() => { void decide(true); }}>Allow access</Button>
      <Button size="lg" disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
    </div>
  </section>;
}
