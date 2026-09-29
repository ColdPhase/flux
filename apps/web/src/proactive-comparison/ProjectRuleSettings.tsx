import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { workspaceAgentsPath, type Agent, type BackgroundComputeConnection, type Project, type ProjectGrant, type ProactiveComparisonRule } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { listAccessibleProjects } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { createPersonalAgent, grantAgentProject, listProjectGrants } from '../agent-connection/api';
import { Button, Spinner } from '../ui';
import { changeBackgroundRule, createBackgroundRule, listBackgroundRules } from './api';

interface ProjectSetup { id: string; agents: Agent[]; grants: ProjectGrant[] | null; rules: ProactiveComparisonRule[] }
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Only the signed-in person's rules and agents are offered. The server checks every mutation again. */
export function ProjectRuleSettings({ connection }: { connection: BackgroundComputeConnection | null }) {
  const { me } = useShellData();
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [agentId, setAgentId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const selected = projects?.find((project) => project.id === projectId);
  const ready = setup?.id === projectId ? setup : null;
  const current = ready?.rules.find((rule) => rule.status !== 'revoked');
  const writable = selected?.access === 'manager' || selected?.access === 'contributor';

  useEffect(() => {
    const controller = new AbortController();
    listAccessibleProjects(controller.signal).then(({ projects }) => {
      if (!controller.signal.aborted) {
        setProjects(projects);
        setProjectId((id) => projects.some((project) => project.id === id) ? id : '');
      }
    }, () => { if (!controller.signal.aborted) setError('Your current project list could not load. Reload to try again.'); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    Promise.all([
      listBackgroundRules(selected.id, controller.signal),
      request<Agent[]>(workspaceAgentsPath(selected.workspaceId), { signal: controller.signal }).catch((cause) => {
        if (cause instanceof ApiError && cause.status === 403) return []; throw cause;
      }),
      selected.access === 'manager' ? listProjectGrants(selected.id, controller.signal) : Promise.resolve(null),
    ]).then(([rules, agents, grants]) => {
      if (!controller.signal.aborted) setSetup({ id: selected.id, rules, grants,
        agents: agents.filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt) });
    }, () => { if (!controller.signal.aborted) setError('This project or its agent access is no longer available. Choose a current project or reload.'); });
    return () => controller.abort();
  }, [selected, me.user.id, refresh]);

  async function mutate(action: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true); setError(''); setSaved('');
    try { await action(); setSaved(message); requestAnimationFrame(() => statusRef.current?.focus()); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === 'AGENT_NOT_FOUND') setError('Choose your own agent with contributor access to this project. A project manager can grant that access.');
      else if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        setSetup(null); setAgentId(''); setRefresh((value) => value + 1);
        setError('The rule changed. Review its current state before trying again.');
      } else if (cause instanceof ApiError && cause.status === 400) setError('Check the agent, allowance and daily limit, then try again.');
      else setError('The change could not be saved. Your current access and the rule may have changed; reload before trying again.');
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !ready) return;
    const data = new FormData(event.currentTarget);
    if (data.get('ruleConsent') !== 'on') return;
    void mutate(async () => {
      const rule = await createBackgroundRule(selected.id, { agentId, trigger: 'human_negative_result',
        purpose: 'camera_sensor_comparison', dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
        maxRunsPerDay: Number(data.get('ruleDaily')), periodBudgetCents: Math.round(Number(data.get('rulePeriod')) * 100),
        perRunCents: Math.round(Number(data.get('rulePerRun')) * 100) });
      setSetup({ ...ready, rules: [...ready.rules, rule] });
    }, 'Paused rule created. No background request was started.');
  }

  return <section className="background-settings__section" aria-labelledby="background-rules">
    <h3 id="background-rules">Rules for your projects</h3>
    <p className="background-settings__help">Each rule belongs to you. A contributor's committed negative result can ask your agent for a quiet camera/sensor comparison; people retain decisions and work changes.</p>
    <div className="background-settings__select"><label htmlFor="background-rule-project">Project</label><select id="background-rule-project" value={projectId} disabled={busy || !projects} onChange={(event) => {
      setProjectId(event.target.value); setSetup(null); setRefresh(0); setError(''); setSaved('');
    }}><option value="">Choose a project</option>{projects?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
    {selected && !ready && !error ? <Spinner label="Loading your project rules" /> : null}
    {error ? <p ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
    {saved ? <p ref={statusRef} className="background-settings__saved" role="status" tabIndex={-1}>{saved}</p> : null}
    {selected && ready ? <>
      <p className="background-settings__help">Scope: human evidence published in <strong>{selected.name}</strong>; no private captures, DMs or other projects. Suggestions are visible to this project's readers.</p>
      {!writable ? <p className="background-settings__note">Your project access is read-only. You cannot create or change a rule here. Disconnect your background connection above to stop all use of that key.</p> : null}
      {current ? <>
        <dl className="background-settings__metadata">
          <div><dt>Status</dt><dd>{current.status === 'enabled' ? 'Enabled' : 'Paused'} · version {current.version}</dd></div>
          <div><dt>Your agent</dt><dd>{ready.agents.find((agent) => agent.id === current.agentId)?.name ?? 'Personal agent no longer available'}</dd></div>
          <div><dt>Rule allowance</dt><dd>{money(current.periodBudgetCents)} over rolling 30 days · up to {current.maxRunsPerDay} requests a UTC day · {money(current.perRunCents)} per request</dd></div>
        </dl>
        <div className="background-settings__actions">
          {current.status === 'enabled' ? <Button disabled={!writable || busy} onClick={() => void mutate(async () => {
            const changed = await changeBackgroundRule(current, 'paused');
            setSetup({ ...ready, rules: ready.rules.map((rule) => rule.id === changed.id ? changed : rule) });
          }, 'Rule paused.')}>Pause rule</Button> : <Button disabled>Enable unavailable</Button>}
          <Button disabled={!writable || busy} onClick={() => void mutate(async () => {
            const changed = await changeBackgroundRule(current, 'revoked');
            setSetup({ ...ready, rules: ready.rules.map((rule) => rule.id === changed.id ? changed : rule) });
          }, 'Rule revoked permanently. Its history and possible charges remain.')}>Revoke rule</Button>
        </div>
      </> : writable ? <>
        {ready.rules.length ? <p className="background-settings__note">Your earlier rule is permanently revoked. A fresh rule needs your new scope and allowance confirmation and starts paused.</p> : null}
        <details className="background-settings__agent-option" open={ready.agents.length === 0}>
        <summary>{ready.agents.length ? 'Create another personal agent' : 'Create your personal agent'}</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void mutate(async () => {
            const agent = await createPersonalAgent(selected.workspaceId, String(data.get('agentName') ?? '').trim());
            setSetup({ ...ready, agents: [...ready.agents, agent] }); setAgentId(agent.id);
          }, 'Personal agent created. It still needs contributor access to this project.');
        }} className="background-settings__agent-create">
          <label className="background-settings__select">New personal agent name<input name="agentName" required minLength={2} maxLength={120} defaultValue="My comparison assistant" disabled={busy} /></label>
          <Button type="submit" disabled={busy}>Create personal agent</Button>
        </form>
        </details>
        <form onSubmit={create}>
          <fieldset className="background-settings__fields" disabled={busy}>
            <div className="background-settings__select"><label htmlFor="background-rule-agent">Your personal agent</label><select id="background-rule-agent" value={agentId} required onChange={(event) => setAgentId(event.target.value)}>
              <option value="">Choose your agent</option>{ready.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select></div>
            {selected.access === 'manager' && agentId && !ready.grants?.some((grant) => grant.principal.kind === 'agent' && grant.principal.id === agentId && grant.role === 'contributor') ?
              <Button onClick={() => void mutate(async () => {
                const grant = await grantAgentProject(selected.id, agentId, 'contributor');
                setSetup({ ...ready, grants: [...(ready.grants ?? []).filter((item) => item.principal.kind !== 'agent' || item.principal.id !== agentId), grant] });
              }, 'Your agent has contributor access to this project.')}>Grant project contributor access</Button> : null}
            <div className="background-settings__limits">
              <label>Rule maximum requests a day<input name="ruleDaily" type="number" required min={1} max={3} step={1} defaultValue={connection?.maxRunsPerDay ?? 1} /></label>
              <label>Rule 30-day allowance (USD)<input name="rulePeriod" type="number" required min="0.05" max="5.00" step="0.01" defaultValue={(Math.min(connection?.periodBudgetCents ?? 100, 500) / 100).toFixed(2)} /></label>
              <label>Rule per-request allowance (USD)<input name="rulePerRun" type="number" required min="0.05" max="0.50" step="0.01" defaultValue={((connection?.perRunCents ?? 5) / 100).toFixed(2)} /></label>
            </div>
            <label className="background-settings__check"><input type="checkbox" name="ruleConsent" required /><span>I choose this personal agent, project scope, quiet effect and allowance. The rule is created paused and cannot start a paid request.</span></label>
            <Button type="submit" variant="primary" disabled={!agentId || busy}>Create paused rule</Button>
          </fieldset>
        </form>
      </> : null}
      {ready.rules.some((rule) => rule.status === 'revoked') ? <p className="background-settings__help">Revoked rule history is preserved. Revocation cannot reset already incurred or possible charges.</p> : null}
      <Link className="background-settings__back" to={`/projects/${selected.id}/tasks`}>Continue work in {selected.name}</Link>
    </> : null}
  </section>;
}
