import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { type Agent, type AgentRuntimePayer, type AssistantModelPick, type PersonalAssistantStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { createPersonalAgent } from '../agent-connection/api';
import { listAgents } from '../work/api';
import { Button, ErrorState, Icon, Kreska, Spinner, Select, Option } from '../ui';
import { enableAssistant, getAssistantStatus, pauseAssistant, removeAssistant, resumeAssistant, selectAssistantAgent, tellOperator } from './api';
import { ModelPicker } from './ModelPicker';
import { modelOption, refreshAssistantModel, useAssistantModel } from './model';
import { connectionName, dollars, micros, runtimeNames, runtimePayerDetail, runtimePayerText, SERVER_AI_OFF_LINE, stateLine, unavailableText, type RuntimeClientName } from './format';
import '../notifications/notifications.css';
import './assistant.css';
import { AssistantControls, AssistantHeader } from './AssistantScreen';
import { AssistantReactions } from './AssistantReactions';
import { AssistantSchedules } from './AssistantSchedules';

// Your assistant (#68; Connect AI #854): only the signed-in person's own assistant. It runs on a model of one of their
// connections, picked in one list grouped by connection; turning it on asks for nothing else (no consent per use, no caps:
// Flux sets no limits of its own; an API key keeps its one daily budget). Nothing here can see or use anyone else's
// assistant or payer. The server decides; this page says truthfully what it decided and why an assistant cannot run.

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

export function AssistantSettings() {
  const { me, workspaces } = useShellData();
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const [pausing, setPausing] = useState(false);
  const fetchAll = useCallback(() => {
    getAssistantStatus().then(setStatus).catch(() => setFailed(true));
    Promise.all(workspaces.map((space) => listAgents(space.id).catch(() => [] as Agent[])))
      .then((lists) => setAgents(lists.flat().filter((agent) => agent.owner.kind === 'human' && agent.owner.id === me.user.id && !agent.revokedAt)))
      .catch(() => setAgents([]));
  }, [workspaces, me.user.id]);
  useEffect(fetchAll, [fetchAll]);
  const load = () => { setFailed(false); fetchAll(); };
  const done = (next: PersonalAssistantStatus, message: string) => { setStatus(next); setSaved(message); window.setTimeout(() => setSaved(''), 2500); void refreshAssistantModel(); };

  if (failed) return <div className="pane-scroll"><div className="pane-in"><ErrorState title="Your assistant settings couldn’t load" actions={<Button variant="secondary" onClick={load}>Try again</Button>}><p>Nothing changed. Human work goes on as usual.</p></ErrorState></div></div>;
  if (!status || !agents) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading your assistant" /></p></div></div>;
  // Nothing can run an assistant on this server (no provider, no agent sign-in) and none is set up: one calm line and the
  // way back, not a set-up form whose every step is disabled (#763 SG-2).
  if (!status.enablement && status.setup.provider === 'off' && status.setup.runtime?.state === 'off') {
    return (
      <div className="pane-scroll"><div className="pane-in nset aset" data-assistant="server-off">
        <div className="inbox__head"><div><h2>Your assistant</h2><p>{SERVER_AI_OFF_LINE}. Your own agent app, such as Claude Code or Codex, can still connect through <Link className="ui-link" to="/connect-agent">local co-work</Link>.</p></div></div>
        <p className="nset__note"><Link className="ui-link" to="/settings/agents">Back to AI</Link></p>
      </div></div>
    );
  }
  const shown: PersonalAssistantStatus = status;
  const addAgent = (agent: Agent) => setAgents((current) => [...(current ?? []), agent]);

  return (
    <div className="pane-scroll"><div className="pane-in nset aset">
      {status.enablement ? <>
        <AssistantHeader name={me.user.name} userId={me.user.id} status={status} busy={!!pausing}
          onToggle={(on) => { setPausing(true); (on ? resumeAssistant() : pauseAssistant()).then((next) => done(next, on ? 'Resumed' : 'Paused'), () => undefined).finally(() => setPausing(false)); }} />
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>
        <AssistantControls status={shown} userId={me.user.id} />
        <AssistantSchedules status={shown} userId={me.user.id} />
        <AssistantReactions status={shown} userId={me.user.id} />
      </> : <div className="inbox__head">
        <div>
          <h2>Your assistant</h2>
          <p>An optional helper that answers in a project conversation when you ask it. Only you can use it; the people in that conversation see its answers. Flux works fully without it.</p>
        </div>
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>
      </div>}
      {status.enablement
        ? <details className="aset__more"><summary>More<span className="aset__more-hint"> · Connection, workspaces and turning it off</span></summary><Enabled status={shown} agents={agents} workspaces={workspaces} onChange={done} onRemoved={() => { setStatus(null); load(); }} onAgent={addAgent} name={me.user.name} /></details>
        : <Setup status={status} agents={agents} workspaces={workspaces} name={me.user.name} onEnabled={(next) => done(next, 'Assistant turned on')} onAgent={addAgent} />}
    </div></div>
  );
}

/** Settings → Your assistant → How it works: what leaves Flux, who pays and that Flux adds no limits, in one plain page. */
export function AssistantHowItWorks() {
  const [status, setStatus] = useState<PersonalAssistantStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then(setStatus, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  return (
    <div className="pane-scroll"><div className="pane-in nset aset">
      <div className="inbox__head">
        <div>
          <h2>How your assistant works</h2>
          <p>Only you can use it. It answers in a project conversation when you ask, and Flux works fully without it.</p>
        </div>
      </div>
      {status ? (
        <section className="nset__sec" aria-label="Details">
          <ConnectionFacts status={status} />
        </section>
      ) : failed ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />This could not load. Try again.</p>
        : <p className="inbox__loading"><Spinner label="Loading how your assistant works" /></p>}
      <p className="nset__note"><Link className="ui-link" to="/settings/agents">Back to AI</Link></p>
    </div></div>
  );
}

/**
 * What running on a connection means (F-022 "Payer and data", #854): where its words go, who pays and that Flux adds no limit
 * of its own. For a plan: the CLI on this server and the plan's own limits. For an API key: its one daily budget.
 */
function ConnectionFacts({ status, client, payer }: { status: PersonalAssistantStatus; client?: RuntimeClientName; payer?: AgentRuntimePayer | null }) {
  const plan = client !== undefined ? client !== null : status.enablement ? status.enablement.engine === 'runtime' : status.setup.runtime?.state === 'signed_in';
  const which = client ?? status.setup.runtime?.client;
  const names = runtimeNames(which);
  const codex = which === 'codex';
  if (plan) {
    const detail = runtimePayerDetail(payer ?? status.setup.runtime?.payer, which);
    return (
      <ul className="aset__facts">
        <li><b>Account</b><span>{names.cli} · {runtimePayerText(payer ?? status.setup.runtime?.payer, which)}. {names.cli} runs unchanged in your own place on this Flux server, signed in as you.</span></li>
        <li><b>Who pays</b><span>{detail[0]!.toUpperCase()}{detail.slice(1)}. Flux can’t tell whether a request used your plan’s limits or paid extra usage. Never another person or the workspace.</span></li>
        <li><b>What leaves Flux</b><span>What your request needs from the one project you ask in, read by {names.cli} through Flux and only from the areas you switched on, other members’ messages included. Never your direct messages, private notes, private maps or other projects.</span></li>
        <li><b>Where it goes</b><span>{codex ? 'To OpenAI, under your ChatGPT or OpenAI account’s settings. On personal ChatGPT plans OpenAI may train on it unless you turned that off in ChatGPT’s data controls.'
          : 'To Anthropic, under your Claude account’s settings. On personal Claude plans Anthropic may train on it unless you turned that off in Claude’s privacy settings.'}</span></li>
        <li><b>Who sees answers</b><span>The people in that conversation. They see that your assistant uses {names.plan}, never your plan or account.</span></li>
        <li><b>Limits</b><span>Flux adds no limits of its own. If your plan’s limit is reached, it pauses and resumes by itself when the plan resets. It never switches to another connection.</span></li>
      </ul>
    );
  }
  return (
    <ul className="aset__facts">
      <li><b>Account</b><span>Your own API key. Your request is sent from the Flux server, never from your browser.</span></li>
      <li><b>Who pays</b><span>The provider account of your key. Never another person or the workspace.</span></li>
      <li><b>What leaves Flux</b><span>Excerpts from the one project conversation you ask in: its latest messages, its open work and a map thought you select. Never your direct messages, private notes, private maps or other projects.</span></li>
      <li><b>Who sees answers</b><span>The people in that conversation. They never see your cost, budget or key.</span></li>
      <li><b>Limits</b><span>Only your key’s daily budget{status.today ? ` (${dollars(status.today.budgetCents)})` : ''}. Flux prices each request before it is sent, so a day stays within it; at the budget your assistant pauses until the next day. It never switches to another connection.</span></li>
    </ul>
  );
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
      {own.length ? <Select id={id} value={value} disabled={disabled} onChange={(next) => onChange(next)}>
        <Option value="">Not in this company</Option>
        {own.map((agent) => <Option key={agent.id} value={agent.id}>{agent.name}</Option>)}
      </Select> : <Button variant="secondary" icon="plus" busy={busy} disabled={disabled} onClick={() => void create()}>Create your assistant here</Button>}
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </div>
  );
}

type SetupProps = {
  status: PersonalAssistantStatus; agents: Agent[]; workspaces: { id: string; name: string }[]; name: string;
  onEnabled: (status: PersonalAssistantStatus) => void; onAgent: (agent: Agent) => void;
};

/**
 * Turning the assistant on (#854): one model from any connection, picked in one list grouped by connection, with Connect AI's
 * default (the connection made first) preselected; then Turn on. "Turn on" is all there is to agree to (F-027 Journey 1
 * step 4). A workspace without an assistant of the person's gets one.
 */
function Setup({ status, agents, workspaces, name, onEnabled, onAgent }: SetupProps) {
  const [chosen, setChosen] = useState<Record<string, string>>(() => Object.fromEntries(workspaces.map((space) => [space.id, agents.find((agent) => agent.workspaceId === space.id)?.id ?? ''])));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The assistants made by an earlier try: a retry after a failed Turn on reuses them and never makes a second one.
  const made = useRef<Record<string, string>>({});
  const running = useRef(false);
  const { choice, loaded } = useAssistantModel();
  const [picked, setPicked] = useState<AssistantModelPick | null>(null);
  const model = picked ?? choice?.default ?? null;
  const group = model ? choice?.groups.find((item) => item.connection === model.connection) ?? null : null;
  const client: RuntimeClientName = group?.account === 'chatgpt_plan' ? 'codex' : group?.account === 'claude_plan' ? 'claude_code' : null;
  const first = name.trim().split(/\s+/)[0] || name;
  async function turnOn() {
    if (busy || running.current || !model) return;
    running.current = true;
    setBusy(true); setError('');
    try {
      const agentIds: string[] = [];
      for (const space of workspaces) {
        let agentId = chosen[space.id] || agents.find((agent) => agent.workspaceId === space.id)?.id || made.current[space.id] || '';
        if (!agentId && !more) {
          const agent = await createPersonalAgent(space.id, `${first}’s assistant`);
          made.current[space.id] = agent.id;
          setChosen((current) => ({ ...current, [space.id]: agent.id }));
          onAgent(agent); agentId = agent.id;
        }
        if (agentId) agentIds.push(agentId);
      }
      if (!agentIds.length) { setError('Choose where your assistant works.'); return; }
      let next = await enableAssistant({ agentId: agentIds[0]!, connection: model.connection, model: model.model });
      for (const agentId of agentIds.slice(1)) next = await selectAssistantAgent(agentId);
      onEnabled(next);
    } catch (cause) {
      setError(failure(cause, 'Couldn’t turn it on. Try again.'));
    } finally { running.current = false; setBusy(false); }
  }
  if (!loaded) return <p className="inbox__loading"><Spinner label="Loading your connections" /></p>;
  if (!choice?.groups.length) {
    return (
      <section className="nset__sec" aria-labelledby="aset-state">
        <h3 id="aset-state">Connect AI first</h3>
        <p className="nset__lead">Your assistant runs on one of your connections: a Claude plan, a ChatGPT plan or an API key.</p>
        <SetupProblem status={status} />
        <div className="aset__actions"><Link className="ui-btn ui-btn--primary" to="/settings/agents">Connect AI</Link></div>
      </section>
    );
  }
  const option = modelOption(choice, model);
  return (
    <section className="nset__sec aset-ready" aria-labelledby="aset-ready">
      <h3 id="aset-ready" className="aset-ready__h"><Kreska size={36} />Your assistant is ready</h3>
      <ul className="aset-ready__list">
        <li>It can read and edit tasks, the Wiki and maps, reply in conversations and suggest decisions.</li>
        <li>It does things and tells you what it did, with Undo. Deleting and other people&apos;s things always wait for your OK.</li>
        <li>It has your rights: it can open and change only what you can.</li>
        <li>Others in the conversation see what you ask it and what it does.</li>
      </ul>
      <p className="nset__note">{client ? `Uses your ${runtimeNames(client).plan} plan. Flux adds no limits of its own; your plan’s limits apply.`
        : `Uses your ${group ? group.label : 'API key'}. Its one daily budget is the only limit.`}</p>
      {model ? <div className="aset-ready__model">
        <ModelPicker groups={choice.groups} value={model} variant="field" disabled={busy} onSelect={setPicked} />
        {option && !option.callsTools ? <p className="nset__note">This model can answer but can’t make changes.</p> : null}
      </div> : null}
      {more ? <div className="aset__agents">
        <ConnectionFacts status={status} client={client} />
        {workspaces.map((space) => <AgentPicker key={space.id} workspace={space} agents={agents} name={name} value={chosen[space.id] ?? ''} disabled={busy}
          onAgent={onAgent} onChange={(agentId) => setChosen((current) => ({ ...current, [space.id]: agentId }))} />)}
        <p className="nset__note">You can change what it may do after it is on.</p>
      </div> : null}
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      <div className="aset__actions">
        <Button variant="primary" busy={busy} disabled={!model} onClick={() => void turnOn()}>Turn on</Button>
        <Button variant="quiet" aria-expanded={more} onClick={() => setMore(!more)}>Change what it can do</Button>
      </div>
    </section>
  );
}

/** Why the assistant cannot run on this server, when that is the case. Never pretends it can. */
function SetupProblem({ status }: { status: PersonalAssistantStatus }) {
  if (status.setup.provider !== 'off' || status.setup.runtime.state !== 'off') return null;
  return <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>In-app AI is turned off on this Flux server.</b> Nothing is sent to an AI provider, and Flux works as usual. Your own MCP client, such as Claude Code or Codex, can still connect through a <Link className="ui-link" to="/connect-agent">personal Flux grant</Link>.</span></p>;
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
      setError(failure(cause, 'Couldn’t save. Try again.'));
    } finally { setBusy(''); }
  };
  const today = status.today;
  const used = today?.chargedMicros ?? 0;
  const cap = (today?.budgetCents ?? 0) * 10_000;
  const paused = status.state === 'paused';
  const runtime = enablement.engine === 'runtime';
  return (
    <>
      <section className="nset__sec" aria-labelledby="aset-state">
        <h3 id="aset-state" className="aset__state"><span className={`aset__dot is-${status.state}`} aria-hidden="true" />{stateLine(status)}</h3>
        {status.state === 'unavailable' ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>{unavailableText(status)} Earlier answers stay. Human work goes on as usual.</span></p> : null}
        {status.unavailableReason === 'runtime_off' ? <OperatorRow workspaceId={enablement.agents[0]?.workspaceId ?? null} client={status.setup.runtime?.client} /> : null}
        <p className="nset__lead">Pausing stops work before its next read or save. Everyone keeps working as usual.</p>
        <div className="aset__actions">
          {paused
            ? <Button variant="primary" busy={busy === 'resume'} onClick={() => void act('resume', resumeAssistant, 'Resumed')}>Resume</Button>
            : <Button variant="secondary" busy={busy === 'pause'} onClick={() => void act('pause', pauseAssistant, 'Paused')}>Pause</Button>}
        </div>
      </section>
      <section className="nset__sec" aria-labelledby="aset-today">
        <h3 id="aset-today">Connection</h3>
        <p className="nset__lead">{connectionName(enablement.connection)}{runtime ? ` · ${runtimePayerText(status.setup.runtime?.payer, status.setup.runtime?.client)}` : ''}</p>
        {runtime ? <p className="nset__note">Usage counts on {runtimePayerDetail(status.setup.runtime?.payer, status.setup.runtime?.client)}. Flux adds no limits of its own. If your plan’s limit is reached, it pauses and resumes by itself. It never switches to another connection.</p> : <>
          <div className="aset__meter" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)} aria-label={`${micros(used)} of your ${dollars(today?.budgetCents ?? 0)} daily budget`}>
            <span style={{ width: `${Math.min(100, cap ? (used / cap) * 100 : 0)}%` }} />
          </div>
          <p className="nset__note">{micros(used)} used of your key’s {dollars(today?.budgetCents ?? 0)} daily budget. At the budget it pauses until the next day. It never switches to another connection. <Link className="ui-link" to="/settings/agents">Change the budget in Connect AI</Link></p>
        </>}
      </section>
      <section className="nset__sec" aria-labelledby="aset-agents">
        <h3 id="aset-agents">Your assistant in the company</h3>
        <p className="nset__lead">It has exactly your rights: it reads and changes only what you can.</p>
        {workspaces.map((space) => <AgentPicker key={space.id} workspace={space} agents={agents} name={name} disabled={!!busy}
          value={enablement.agents.find((item) => item.workspaceId === space.id)?.agentId ?? ''} onAgent={onAgent}
          onChange={(agentId) => { if (agentId) void act(`agent-${space.id}`, () => selectAssistantAgent(agentId), 'Assistant chosen'); }} />)}
      </section>
      <section className="nset__sec" aria-labelledby="aset-off">
        <h3 id="aset-off">How it works</h3>
        <ConnectionFacts status={status} />
        {confirmRemove ? <div className="details__confirm" role="group" aria-label="Turn off your assistant">
          <p>Your assistant stops at once. Its earlier answers stay in their conversations.</p>
          <div className="aset__actions">
            <Button variant="danger" busy={busy === 'remove'} onClick={() => void act('remove', async () => { await removeAssistant(); return null; }, '')}>Turn off</Button>
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div> : <Button variant="quiet" onClick={() => setConfirmRemove(true)}>Turn off my assistant…</Button>}
      </section>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </>
  );
}

/** Journey 6, "Subscription sign-in off on this Flux": tell whoever runs it, or connect a key of your own. */
function OperatorRow({ workspaceId, client }: { workspaceId: string | null; client?: 'claude_code' | 'codex' | null }) {
  const [told, setTold] = useState<'idle' | 'busy' | 'told' | 'failed'>('idle');
  return (
    <div className="aset__actions">
      {workspaceId ? <Button variant="secondary" busy={told === 'busy'} onClick={() => { setTold('busy'); tellOperator(workspaceId, client).then(() => setTold('told'), () => setTold('failed')); }}>Tell whoever runs Flux</Button> : null}
      <Link className="ui-btn ui-btn--secondary" to="/settings/ai-connections?new=1">Connect an API key</Link>
      <span role="status" aria-live="polite" className="nset__note">{told === 'told' ? 'Told whoever runs Flux.' : told === 'failed' ? 'Couldn’t tell them. Try again.' : ''}</span>
    </div>
  );
}
