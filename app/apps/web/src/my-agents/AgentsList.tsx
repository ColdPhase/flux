import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import { AGENT_ALWAYS_WAITS, type MyAgent } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { Button, Icon, Kreska } from '../ui';
import { useAssistantModel } from '../assistant/model';
import { createMyAgent } from './api';
import { jobLine, mayDoLabel, modelLine } from './agentLabel';
import './my-agents.css';

// Settings › AI › Your agents (F-036 AG-1, #857; mockup Main): one row per agent with its Kreska in its own colour, its name, one
// line about its job, its tag ("Ask me first on" or "Ask me first off", #1419, #1424) and its model with the connection. The first, Assistant, carries "Answers /ai".
// "New agent" asks only for a name; the agent starts on Connect AI's default model and is given a colour, and its page is where
// the rest is set. Connecting AI the first time gives a person their Assistant: the server makes it once, when the connection is
// made, so deleting it (or every agent) is never undone by opening this page.

const failure = (cause: unknown) => (cause instanceof ApiError && cause.status < 500 && cause.message ? cause.message : 'Couldn’t make it. Try again.');

/** `listed`: Connect AI above lists a connection, usable or not. */
export function AgentsList({ listed = false }: { listed?: boolean } = {}) {
  const { agents, workspace } = useShellData();
  const { choice, loaded } = useAssistantModel();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = !!choice?.groups.length;

  async function add(event: FormEvent) {
    event.preventDefault();
    const named = name.trim();
    if (!workspace || !named || busy) return;
    setBusy(true); setError('');
    try {
      const agent = await createMyAgent({ workspaceId: workspace.id, name: named });
      await revalidator.revalidate();
      navigate(`/settings/agents/${agent.id}`);
    } catch (cause) { setError(failure(cause)); setBusy(false); }
  }

  return (
    <section className="agl" aria-labelledby="your-agents">
      <div className="agl__head">
        <div className="agl__title">
          <h3 className="sset-sub agl__h" id="your-agents">Your agents</h3>
          <span className="agl__lead">Message them in Messages, or make one the owner of a task.</span>
        </div>
        {connected && !adding ? <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>New agent</Button> : null}
      </div>
      {adding ? (
        <form className="sset-card agl__new" onSubmit={(event) => void add(event)}>
          <label className="agl__label" htmlFor="new-agent-name">Name</label>
          <input id="new-agent-name" className="agl__input" value={name} maxLength={80} autoComplete="off" placeholder="Planner, Reviewer…" onChange={(event) => setName(event.target.value)} autoFocus />
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Make agent</Button>
          <Button variant="secondary" onClick={() => { setAdding(false); setName(''); setError(''); }}>Cancel</Button>
          {error ? <p className="nset__error agl__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
        </form>
      ) : null}
      {agents.length ? (
        <ul className="sset-card agl__list" aria-label="Your agents">
          {agents.map((agent, index) => <AgentRow key={agent.id} agent={agent} answers={index === 0} choice={choice} />)}
        </ul>
      ) : loaded && !connected && listed ? (
        // A connection is listed above, but none can run an agent (a key whose model has no known price, a plan to sign in to again).
        <div className="sset-card agl__empty"><span className="agl__empty-text">None of your connections can run an agent yet. Your first agent, Assistant, appears once one can and answers <code>/ai</code>.</span></div>
      ) : loaded && !connected ? (
        <div className="sset-card agl__empty"><span className="agl__empty-text">Connect AI first. Your first agent, Assistant, appears then and answers <code>/ai</code>.</span></div>
      ) : loaded ? (
        <div className="sset-card agl__empty"><span className="agl__empty-text">You have no agents. Make one with New agent.</span></div>
      ) : null}
      {agents.length ? <p className="agl__note"><Icon name="lock" size={13} />{AGENT_ALWAYS_WAITS}</p> : null}
    </section>
  );
}

function AgentRow({ agent, answers, choice }: { agent: MyAgent; answers: boolean; choice: ReturnType<typeof useAssistantModel>['choice'] }) {
  const model = modelLine(agent, choice);
  // Assistant says what it is for even before it has instructions (F-026 §7: "Answers your questions and runs your schedules.").
  const job = jobLine(agent) || (answers ? 'Answers your questions and runs your schedules.' : '');
  return (
    <li>
      <Link className="sset-row sset-row--link agl__row" to={`/settings/agents/${agent.id}`} data-agent={agent.id}>
        <span className="sset-row__ic agl__face" aria-hidden="true"><Kreska size={36} hue={agent.colour} /></span>
        <span className="sset-row__b">
          <span className="sset-row__t agl__name"><span className="agl__name-text">{agent.name}</span>{answers ? <span className="agl__tag">Answers /ai</span> : null}</span>
          {job ? <span className="sset-row__s agl__job">{job}</span> : null}
        </span>
        <span className="agl__may">{mayDoLabel(agent)}</span>
        <span className="agl__model"><span>{model.name}</span>{model.connection ? <span>{model.connection}</span> : null}</span>
        <Icon name="chevron-right" size={14} className="sset-row__go" />
      </Link>
    </li>
  );
}
