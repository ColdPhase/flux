import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { AI_PROVIDERS, aiConnectionLabel, maxRequestMicros, PERSONAL_RUN_CONSENT_VERSION, PERSONAL_RUN_LIMITS, type Agent, type BackgroundComputeConnection, type PersonalAssistantStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { createPersonalAgent } from '../agent-connection/api';
import { listAgents } from '../work/api';
import { Button, ErrorState, Icon, Spinner } from '../ui';
import { listBackgroundConnections } from '../proactive-comparison/api';
import { enableAssistant, getAssistantStatus, pauseAssistant, removeAssistant, resumeAssistant, selectAssistantAgent, updateAssistant } from './api';
import { dollars, micros, perMillion, stateLine, unavailableText } from './format';
import '../notifications/notifications.css';
import './assistant.css';

// Your assistant (#68 AC-8, O-008 §1/§3/§6): only the signed-in person's own enablement,
// consent, caps and pause. Nothing here can see or use anyone else's assistant or payer. The
// server decides; this page says truthfully what it decided and why an assistant cannot run.

const PER_RUN = [6, 10, 20, 30, 50].filter((value) => value >= PERSONAL_RUN_LIMITS.perRunCents.min && value <= PERSONAL_RUN_LIMITS.perRunCents.max);
const DAILY = [10, 50, 100, 200, 500, 1000].filter((value) => value >= PERSONAL_RUN_LIMITS.dailyCapCents.min && value <= PERSONAL_RUN_LIMITS.dailyCapCents.max);

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

export function AssistantSettings() {
  const { me, workspaces } = useShellData();
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const fetchAll = useCallback(() => {
    getAssistantStatus().then(setStatus).catch(() => setFailed(true));
    Promise.all(workspaces.map((space) => listAgents(space.id).catch(() => [] as Agent[])))
      .then((lists) => setAgents(lists.flat().filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt)))
      .catch(() => setAgents([]));
  }, [workspaces, me.user.id]);
  useEffect(fetchAll, [fetchAll]);
  const load = () => { setFailed(false); fetchAll(); };
  const done = (next: PersonalAssistantStatus, message: string) => { setStatus(next); setSaved(message); window.setTimeout(() => setSaved(''), 2500); };

  if (failed) return <div className="pane-scroll"><div className="pane-in"><ErrorState title="Your assistant settings couldn’t load" actions={<Button variant="secondary" onClick={load}>Try again</Button>}><p>Nothing changed. Human work goes on as usual.</p></ErrorState></div></div>;
  if (!status || !agents) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading your assistant" /></p></div></div>;

  return (
    <div className="pane-scroll"><div className="pane-in nset aset">
      <div className="inbox__head">
        <div>
          <h2>Your assistant</h2>
          <p>An optional helper that answers in a project conversation when you ask it. Only you can use it; the people in that conversation see its answers. Flux works fully without it.</p>
        </div>
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>
      </div>
      {status.enablement
        ? <Enabled status={status} agents={agents} workspaces={workspaces} onChange={done} onRemoved={() => { setStatus(null); load(); }} onAgent={(agent) => setAgents((current) => [...(current ?? []), agent])} name={me.user.name} />
        : <Setup status={status} agents={agents} workspaces={workspaces} name={me.user.name} onEnabled={(next) => done(next, 'Assistant turned on')} onAgent={(agent) => setAgents((current) => [...(current ?? []), agent])} />}
    </div></div>
  );
}

/** Why the assistant cannot run on this server, when that is the case. Never pretends it can. */
function SetupProblem({ status }: { status: PersonalAssistantStatus }) {
  if (status.setup.provider === 'off') return <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>In-app AI is turned off on this Flux server.</b> Nothing is sent to an AI provider, and Flux works as usual. Your own MCP client, such as Claude Code or Codex, can still connect through a <Link className="ui-link" to="/connect-agent">personal Flux grant</Link>.</span></p>;
  if (status.setup.connection === 'none') return <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Your own AI key isn’t connected.</b> Add an AI connection with your own key in <Link className="ui-link" to="/settings/background-compute">AI connections</Link>, from any supported provider. Nobody else’s key is ever used for you.</span></p>;
  return null;
}

function AgentPicker({ workspace, agents, value, onChange, onAgent, name, disabled }: {
  workspace: { id: string; name: string }; agents: Agent[]; value: string; onChange: (agentId: string) => void; onAgent: (agent: Agent) => void; name: string; disabled?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const own = agents.filter((agent) => agent.workspaceId === workspace.id);
  async function create() {
    setBusy(true); setError('');
    try {
      const agent = await createPersonalAgent(workspace.id, `${name.trim().split(/\s+/)[0] || name}’s assistant`);
      onAgent(agent); onChange(agent.id);
    } catch (cause) { setError(failure(cause, 'Couldn’t create it. Try again.')); }
    finally { setBusy(false); }
  }
  return (
    <div className="aset__agent">
      <label htmlFor={id}>In {workspace.name}</label>
      {own.length ? <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not in this workspace</option>
        {own.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select> : <Button variant="secondary" icon="plus" busy={busy} disabled={disabled} onClick={() => void create()}>Create your assistant here</Button>}
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </div>
  );
}

/** The provider of the caller's own connection, named only when that is the connection (PROV-2). */
const providerName = (status: PersonalAssistantStatus) =>
  status.disclosure.provider ? (status.disclosure.provider === 'openai_compatible' ? 'your own endpoint' : AI_PROVIDERS[status.disclosure.provider].label) : 'your connection’s AI provider';

function Disclosure({ status, perRun, daily, timeZone, payer: chosenPayer }: {
  status: PersonalAssistantStatus; perRun: number; daily: number; timeZone: string; payer?: { organization: string; workspace: string } | null;
}) {
  const { disclosure } = status;
  const payer = chosenPayer ?? status.enablement?.consent.payer;
  const price = disclosure.price;
  return (
    <ul className="aset__facts">
      <li><b>Provider</b><span>{disclosure.provider && disclosure.model ? aiConnectionLabel(disclosure.provider, disclosure.model) : 'The provider and model of your own AI connection'}. Your request is sent from the Flux server, never from your browser.</span></li>
      <li><b>Who pays</b><span>{payer ? `${payer.organization} · ${payer.workspace}, through your own API key.` : 'The organization of your own API key. Never another person or the workspace.'}</span></li>
      <li><b>What leaves Flux</b><span>Excerpts from the one project conversation you ask in: its latest messages, its open work and a map thought you select. Never your direct messages, private notes, private maps or other projects.</span></li>
      <li><b>Who sees answers</b><span>The people in that conversation. They never see your cost, cap or key.</span></li>
      <li><b>Cost</b><span>Each request uses at most {disclosure.maxInputTokens.toLocaleString('en')} input and {disclosure.maxOutputTokens.toLocaleString('en')} output tokens{disclosure.maxRunMicros !== null ? ` and reserves the most that can cost, ${micros(disclosure.maxRunMicros)}` : ''}, never more than your {dollars(perRun)} per-request limit. It stops at {dollars(daily)} a day, reset at midnight in {timeZone}. The cap is a Flux limit, not a guarantee on the provider’s invoice. {price ? `Price ${perMillion(price.inputMicrosPerMTok)} input and ${perMillion(price.outputMicrosPerMTok)} output per 1M tokens, ${price.source === 'table' ? `from Flux’s price table, checked ${price.checkedOn}` : 'entered by you'}.` : 'No price is known for your connection yet, so it cannot be used.'}</span></li>
    </ul>
  );
}

function Setup({ status, agents, workspaces, name, onEnabled, onAgent }: {
  status: PersonalAssistantStatus; agents: Agent[]; workspaces: { id: string; name: string }[]; name: string;
  onEnabled: (status: PersonalAssistantStatus) => void; onAgent: (agent: Agent) => void;
}) {
  const [perRun, setPerRun] = useState<number>(PERSONAL_RUN_LIMITS.perRunCents.default);
  const [daily, setDaily] = useState<number>(PERSONAL_RUN_LIMITS.dailyCapCents.default);
  const [chosen, setChosen] = useState<Record<string, string>>(() => Object.fromEntries(workspaces.map((space) => [space.id, agents.find((agent) => agent.workspaceId === space.id)?.id ?? ''])));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // F-020 PROV-1: with more than one of the owner's own connections, they choose which one the
  // assistant uses; with one, that one is used. Never another person's.
  const [owned, setOwned] = useState<BackgroundComputeConnection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listBackgroundConnections(controller.signal).then((items) => { setOwned(items); setConnectionId(items[0]?.id ?? ''); }).catch(() => setOwned([]));
    return () => controller.abort();
  }, []);
  // The disclosure and the consent describe exactly the connection being enabled: its provider, model,
  // price, largest request and payer, never the server's default choice (#192 review B2).
  const selected = owned.find((item) => item.id === connectionId) ?? null;
  const shown: PersonalAssistantStatus = selected ? { ...status, disclosure: { ...status.disclosure, provider: selected.provider, model: selected.model,
    price: selected.price ? { ...selected.price } : null,
    maxRunMicros: selected.price ? maxRequestMicros(selected.price, PERSONAL_RUN_LIMITS.maxInputTokens, PERSONAL_RUN_LIMITS.maxOutputTokens) : null } } : status;
  const payer = selected ? { organization: selected.payerOrganization, workspace: selected.providerWorkspace } : null;
  const timeZone = browserTimeZone();
  const usable = status.setup.provider === 'on' && status.setup.connection === 'active';
  const picked = Object.entries(chosen).filter(([, agentId]) => agentId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!usable || !consent || !picked.length || busy) return;
    setBusy(true); setError('');
    try {
      let next = await enableAssistant({ consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: picked[0]![1], perRunCents: perRun, dailyCapCents: daily, timeZone,
        ...(connectionId ? { connectionId } : {}) });
      for (const [, agentId] of picked.slice(1)) next = await selectAssistantAgent(agentId);
      onEnabled(next);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'PERSONAL_RUN_CONNECTION_REQUIRED' ? 'Connect your own AI key first. Nothing was turned on.'
        : cause instanceof ApiError && cause.code === 'PERSONAL_RUN_PRICE_UNKNOWN' ? 'Your AI connection has no known price. Nothing was turned on.'
          : cause instanceof ApiError && cause.code === 'PERSONAL_RUN_COST_OVER_LIMIT' ? 'One request to your model can cost more than this per-request limit. Choose a higher limit. Nothing was turned on.'
            : failure(cause, 'Couldn’t turn it on. Try again.'));
    } finally { setBusy(false); }
  }
  return (
    <>
      <section className="nset__sec" aria-labelledby="aset-state">
        <h3 id="aset-state">Not set up</h3>
        <p className="nset__lead">Nothing runs and nothing is sent until you turn it on here.</p>
        <SetupProblem status={status} />
      </section>
      <form className="nset__sec" aria-labelledby="aset-consent" onSubmit={(event) => void submit(event)}>
        <h3 id="aset-consent">Before you turn it on</h3>
        <Disclosure status={shown} perRun={perRun} daily={daily} timeZone={timeZone} payer={payer} />
        <fieldset className="aset__fields" disabled={!usable || busy}>
          <legend className="ui-vh">Limits and assistant</legend>
          {owned.length > 1 ? <label className="aset__field">AI connection
            <select aria-label="AI connection" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {owned.map((item) => <option key={item.id} value={item.id}>{item.name} · {aiConnectionLabel(item.provider, item.model)}</option>)}
            </select>
          </label> : null}
          <label className="aset__field">Up to per request
            <select aria-label="Up to per request" value={perRun} onChange={(event) => setPerRun(Number(event.target.value))}>{PER_RUN.map((value) => <option key={value} value={value}>{dollars(value)}</option>)}</select>
          </label>
          <label className="aset__field">Daily cap
            <select aria-label="Daily cap" value={daily} onChange={(event) => setDaily(Number(event.target.value))}>{DAILY.filter((value) => value >= perRun).map((value) => <option key={value} value={value}>{dollars(value)}</option>)}</select>
          </label>
          <div className="aset__agents">
            <p className="nset__label">Your assistant</p>
            {workspaces.map((space) => <AgentPicker key={space.id} workspace={space} agents={agents} name={name} value={chosen[space.id] ?? ''} disabled={!usable || busy}
              onAgent={onAgent} onChange={(agentId) => setChosen((current) => ({ ...current, [space.id]: agentId }))} />)}
            <p className="nset__note">It reads a project only where it has been given access, and never more than you can.</p>
          </div>
          <label className="aset__consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>I agree that excerpts from the project conversations I ask in are sent to {providerName(shown)} under my key’s organization, which pays for them.</span>
          </label>
        </fieldset>
        {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
        <div className="aset__actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!usable || !consent || !picked.length}>Turn on my assistant</Button>
          {!usable ? <span className="nset__note">Not available on this server yet.</span> : null}
        </div>
      </form>
    </>
  );
}

function Enabled({ status, agents, workspaces, name, onChange, onRemoved, onAgent }: {
  status: PersonalAssistantStatus; agents: Agent[]; workspaces: { id: string; name: string }[]; name: string;
  onChange: (status: PersonalAssistantStatus, message: string) => void; onRemoved: () => void; onAgent: (agent: Agent) => void;
}) {
  const enablement = status.enablement!;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (key: string, action: () => Promise<PersonalAssistantStatus | null>, message: string) => {
    setBusy(key); setError('');
    try {
      const next = await action();
      if (next) onChange(next, message); else onRemoved();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'VERSION_CONFLICT' ? 'This changed elsewhere. The latest settings are shown.' : failure(cause, 'Couldn’t save. Try again.'));
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') onChange(await getAssistantStatus(), '');
    } finally { setBusy(''); }
  };
  const today = status.today;
  const used = today ? today.chargedMicros + today.reservedMicros : 0;
  const cap = (today?.capCents ?? enablement.dailyCapCents) * 10_000;
  const paused = status.state === 'paused';
  return (
    <>
      <section className="nset__sec" aria-labelledby="aset-state">
        <h3 id="aset-state" className="aset__state"><span className={`aset__dot is-${status.state}`} aria-hidden="true" />{stateLine(status)}</h3>
        {status.state === 'unavailable' ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>{unavailableText(status)} Earlier answers stay. Human work goes on as usual.</span></p> : null}
        <p className="nset__lead">Pausing stops work before its next read or save. Everyone keeps working as usual.</p>
        <div className="aset__actions">
          {paused
            ? <Button variant="primary" busy={busy === 'resume'} onClick={() => void act('resume', resumeAssistant, 'Resumed')}>Resume</Button>
            : <Button variant="secondary" busy={busy === 'pause'} onClick={() => void act('pause', pauseAssistant, 'Paused')}>Pause</Button>}
        </div>
      </section>
      <section className="nset__sec" aria-labelledby="aset-today">
        <h3 id="aset-today">Today</h3>
        <div className="aset__meter" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)} aria-label={`${micros(used)} of your ${dollars(enablement.dailyCapCents)} daily cap`}>
          <span style={{ width: `${Math.min(100, cap ? (used / cap) * 100 : 0)}%` }} />
        </div>
        <p className="nset__note">{micros(today?.chargedMicros ?? 0)} used{today?.reservedMicros ? ` and ${micros(today.reservedMicros)} held for work in progress` : ''} of your {dollars(enablement.dailyCapCents)} daily cap. At the cap it stops and says so. It never switches to another payer.</p>
        <CapsForm key={`${enablement.perRunCents}:${enablement.dailyCapCents}`} status={status} busy={busy === 'caps'} onSave={(perRunCents, dailyCapCents) => act('caps', () => updateAssistant({ perRunCents, dailyCapCents, expectedVersion: enablement.version }), 'Limits saved')} />
      </section>
      <section className="nset__sec" aria-labelledby="aset-agents">
        <h3 id="aset-agents">Your assistant in each workspace</h3>
        <p className="nset__lead">It reads a project only where it has been given access, and never more than you can.</p>
        {workspaces.map((space) => <AgentPicker key={space.id} workspace={space} agents={agents} name={name} disabled={!!busy}
          value={enablement.agents.find((item) => item.workspaceId === space.id)?.agentId ?? ''} onAgent={onAgent}
          onChange={(agentId) => { if (agentId) void act(`agent-${space.id}`, () => selectAssistantAgent(agentId), 'Assistant chosen'); }} />)}
      </section>
      <section className="nset__sec" aria-labelledby="aset-consent">
        <h3 id="aset-consent">What you agreed to</h3>
        <p className="nset__lead">On {new Date(enablement.consent.acceptedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} · disclosure {enablement.consent.version}</p>
        <Disclosure status={status} perRun={enablement.perRunCents} daily={enablement.dailyCapCents} timeZone={enablement.timeZone} />
        {confirmRemove ? <div className="details__confirm" role="group" aria-label="Turn off your assistant">
          <p>Your assistant stops at once and your consent is removed. Its earlier answers stay in their conversations.</p>
          <div className="aset__actions">
            <Button variant="danger" busy={busy === 'remove'} onClick={() => void act('remove', async () => { await removeAssistant(); return null; }, '')}>Turn off and remove consent</Button>
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div> : <Button variant="quiet" onClick={() => setConfirmRemove(true)}>Turn off my assistant…</Button>}
      </section>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </>
  );
}

function CapsForm({ status, busy, onSave }: { status: PersonalAssistantStatus; busy: boolean; onSave: (perRun: number, daily: number) => Promise<void> }) {
  const enablement = status.enablement!;
  const [perRun, setPerRun] = useState(enablement.perRunCents);
  const [daily, setDaily] = useState(enablement.dailyCapCents);
  const changed = perRun !== enablement.perRunCents || daily !== enablement.dailyCapCents;
  const options = (values: number[], current: number) => [...new Set([...values, current])].sort((a, b) => a - b);
  return (
    <form className="aset__caps" onSubmit={(event) => { event.preventDefault(); if (changed) void onSave(perRun, daily); }}>
      <label className="aset__field">Up to per request
        <select aria-label="Up to per request" value={perRun} onChange={(event) => setPerRun(Number(event.target.value))}>{options(PER_RUN, enablement.perRunCents).map((value) => <option key={value} value={value}>{dollars(value)}</option>)}</select>
      </label>
      <label className="aset__field">Daily cap
        <select aria-label="Daily cap" value={daily} onChange={(event) => setDaily(Number(event.target.value))}>{options(DAILY, enablement.dailyCapCents).filter((value) => value >= perRun).map((value) => <option key={value} value={value}>{dollars(value)}</option>)}</select>
      </label>
      <Button type="submit" variant="secondary" busy={busy} disabled={!changed}>Save limits</Button>
    </form>
  );
}
