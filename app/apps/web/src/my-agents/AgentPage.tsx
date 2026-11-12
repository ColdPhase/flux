import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useRevalidator } from 'react-router';
import { AGENT_LIMITS, type AgentMemoryItem, type MyAgent } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { MayDoChoice } from '../agent-connection/MayDoChoice';
import { refreshAssistantModel, useAssistantModel } from '../assistant/model';
import { Button, Icon, Kreska, Spinner } from '../ui';
import { AgentSchedules } from './AgentSchedules';
import { addAgentMemory, deleteAgentMemory, deleteMyAgent, editAgentMemory, getAgentMemory, updateMyAgent } from './api';
import './my-agents.css';

// One agent's page (F-036 AG-1, #857; mockup AiAgents), the same for Assistant: who it is, its name and saved instructions, its
// model (one per agent, grouped by connection), "What it may do", what it remembers and Delete. Every field saves as it is left and
// shows what the server kept. Only the owner reaches this page; another person's agent is not found.

const failure = (cause: unknown, fallback = 'Couldn’t save. Try again.') => (cause instanceof ApiError && cause.status < 500 && cause.message ? cause.message : fallback);
const when = (iso: string) => {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString() ? 'today' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function AgentPage() {
  const { agentId = '' } = useParams();
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div className="pane-scroll"><div className="pane-in nset agp">
        <Link className="agp__back" to="/settings/agents"><Icon name="chevron-left" size={12} />AI</Link>
        <p className="nset__note">This agent isn’t here. It may have been deleted.</p>
      </div></div>
    );
  }
  return <AgentSettings key={agent.id} agent={agent} />;
}

function AgentSettings({ agent }: { agent: MyAgent }) {
  const { choice } = useAssistantModel();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const group = choice?.groups.find((item) => item.connection === agent.model.connection);
  const uses = group ? `uses your ${group.label}` : 'has no connection now';
  const picked = group?.options.find((option) => option.id === agent.model.model);
  // Opus and the Claude limit are named only to someone whose Claude plan offers Opus (#1173); an API key spends its own budget.
  const opus = !!choice?.groups.some((item) => item.account === 'claude_plan' && item.options.some((option) => option.id === 'opus'));

  async function save(change: Parameters<typeof updateMyAgent>[1], message: string) {
    setError('');
    try {
      await updateMyAgent(agent.id, change);
      await Promise.all([revalidator.revalidate(), refreshAssistantModel()]);
      setSaved(message);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSaved(''), 2500);
    } catch (cause) {
      setError(failure(cause));
      // What the server kept is what shows.
      setName(agent.name); setInstructions(agent.instructions);
    }
  }
  const saveName = () => { const next = name.trim(); if (!next) { setName(agent.name); return; } if (next !== agent.name) void save({ name: next }, 'Saved'); else setName(next); };
  const saveInstructions = () => { if (instructions !== agent.instructions) void save({ instructions }, 'Saved'); };

  async function remove() {
    setDeleting(true); setError('');
    try {
      await deleteMyAgent(agent.id);
      await Promise.all([revalidator.revalidate(), refreshAssistantModel()]);
      navigate('/settings/agents', { replace: true });
    } catch (cause) { setError(failure(cause, 'Couldn’t delete it. Try again.')); setDeleting(false); }
  }

  return (
    <div className="pane-scroll"><div className="pane-in nset agp" data-agent-page={agent.id}>
      <Link className="agp__back" to="/settings/agents"><Icon name="chevron-left" size={12} />AI</Link>
      <header className="agp__head">
        <Kreska size={40} hue={agent.colour} />
        <div className="agp__who">
          <h2 className="agp__name">{agent.name}</h2>
          <p className="agp__sub">Your agent · {uses} · can do only what you can</p>
        </div>
        <Link className="ui-btn ui-btn--primary agp__message" to={`/agents/${agent.id}`}>Message {agent.name}</Link>
      </header>
      <span className="nset__saved agp__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>

      <section className="sset-card agp__card" aria-label="Settings">
        <label className="agp__label" htmlFor="agent-name">Name</label>
        <input id="agent-name" className="agp__input" value={name} maxLength={80} autoComplete="off" onChange={(event) => setName(event.target.value)}
          onBlur={saveName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />

        <label className="agp__label" htmlFor="agent-instructions">Instructions</label>
        <textarea id="agent-instructions" className="agp__input agp__text" rows={5} value={instructions} maxLength={AGENT_LIMITS.instructions} onChange={(event) => setInstructions(event.target.value)}
          onBlur={saveInstructions} placeholder="What it is for and how it should work. Plain words are enough." />

        <p className="agp__label" id="agent-model">Model<span className="agp__hint"> · One per agent.{opus ? ' Opus thinks longest and uses your Claude limit fastest.' : ''}</span></p>
        {choice?.groups.length ? (
          <div className="agp__models" role="group" aria-labelledby="agent-model">
            {choice.groups.map((item) => (
              <div key={item.connection} className="agp__model-group">
                <span className="agp__group-name" id={`model-${item.connection}`}>{item.label}</span>
                <div className="seg seg--fit" role="radiogroup" aria-labelledby={`model-${item.connection}`}>
                  {item.options.map((option) => {
                    const on = agent.model.connection === item.connection && agent.model.model === option.id;
                    return (
                      <button key={option.id} type="button" role="radio" className="seg__b" aria-checked={on} tabIndex={on ? 0 : -1} data-model={option.id} data-connection={item.connection}
                        onClick={() => { if (!on) void save({ connection: item.connection, model: option.id }, 'Model changed'); }}>{option.name}</button>
                    );
                  })}
                </div>
              </div>
            ))}
            {picked && !picked.callsTools ? <p className="agp__hint" role="note">{picked.name}: can answer but can’t make changes.</p> : null}
          </div>
        ) : <p className="nset__note">Connect AI to choose a model. <Link className="ui-link" to="/settings/agents">Back to AI</Link></p>}

        <p className="agp__label" id="agent-may-do">What it may do</p>
        <div className="agp__may"><MayDoChoice connectionId={agent.connectionId} initial={agent.mayDo} labelledBy="agent-may-do" /></div>
      </section>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}

      <Remembers agent={agent} />
      <AgentSchedules agent={agent} />

      <div className="agp__delete">
        {confirming ? (
          <div className="details__confirm" role="group" aria-label={`Delete ${agent.name}`}>
            <p>Delete {agent.name}? Its open tasks go back to you, and what it remembers and its schedules are deleted. What it already wrote stays.</p>
            <div className="aset__actions">
              <Button variant="danger" busy={deleting} onClick={() => void remove()}>Delete {agent.name}</Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="quiet" className="agp__delete-btn" onClick={() => setConfirming(true)}>Delete {agent.name}</Button>
            <span className="agp__hint">Its tasks go back to you.</span>
          </>
        )}
      </div>
    </div></div>
  );
}

/** What the agent remembers: only what its owner told it, each item with where it came from. Edit changes or deletes it. */
function Remembers({ agent }: { agent: MyAgent }) {
  const [items, setItems] = useState<AgentMemoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getAgentMemory(agent.id, controller.signal).then(setItems, () => { if (!controller.signal.aborted) { setItems([]); setFailed(true); } });
    return () => controller.abort();
  }, [agent.id]);

  const stop = () => { setEditing(null); setAdding(false); setText(''); setError(''); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setError('');
    try {
      if (editing) {
        const next = await editAgentMemory(agent.id, editing, { body });
        setItems((list) => (list ?? []).map((item) => (item.id === next.id ? next : item)));
      } else {
        const next = await addAgentMemory(agent.id, { body });
        setItems((list) => [...(list ?? []), next]);
      }
      stop();
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  }
  async function remove(item: AgentMemoryItem) {
    setBusy(true); setError('');
    try {
      await deleteAgentMemory(agent.id, item.id);
      setItems((list) => (list ?? []).filter((other) => other.id !== item.id));
      stop();
    } catch (cause) { setError(failure(cause, 'Couldn’t delete it. Try again.')); }
    finally { setBusy(false); }
  }
  const form = (
    <form className="agp__memory-form" onSubmit={(event) => void submit(event)}>
      <label className="ui-vh" htmlFor="memory-text">What {agent.name} should remember</label>
      <textarea id="memory-text" className="agp__input agp__text" rows={2} value={text} maxLength={AGENT_LIMITS.memoryItem} autoFocus onChange={(event) => setText(event.target.value)} />
      <div className="aset__actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>Save</Button>
        {editing ? <Button variant="danger" disabled={busy} onClick={() => void remove(items!.find((item) => item.id === editing)!)}>Delete</Button> : null}
        <Button variant="quiet" onClick={stop}>Cancel</Button>
      </div>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </form>
  );
  return (
    <section className="agp__remembers" aria-labelledby="agent-remembers">
      <div className="agp__remembers-head">
        <h3 className="sset-sub agp__h" id="agent-remembers">Remembers</h3>
        <span className="agp__hint">Tell {agent.name} “remember that…” and it shows up here.</span>
        {items && !adding && !editing ? <Button variant="quiet" size="sm" onClick={() => { setAdding(true); setText(''); }}>Add</Button> : null}
      </div>
      {items === null ? <p className="sset-note"><Spinner label="Loading what it remembers" /></p> : null}
      {failed ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />What it remembers couldn’t load.</p> : null}
      {adding ? <div className="sset-card agp__memory-edit">{form}</div> : null}
      {items?.length ? (
        <ul className="sset-card agp__memory" aria-label={`What ${agent.name} remembers`}>
          {items.map((item) => (
            <li key={item.id} className="sset-row agp__item" data-memory-item={item.id}>
              {editing === item.id ? form : (
                <>
                  <span className="sset-row__b">
                    <span className="sset-row__t agp__item-text">{item.body}</span>
                    <span className="sset-row__s">{item.source} · {when(item.createdAt)}</span>
                  </span>
                  <Button variant="quiet" size="sm" aria-label={`Edit: ${item.body}`} onClick={() => { setEditing(item.id); setAdding(false); setText(item.body); setError(''); }}>Edit</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : items && !adding ? <p className="sset-note">Nothing yet.</p> : null}
    </section>
  );
}
