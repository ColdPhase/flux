import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useRevalidator } from 'react-router';
import { AGENT_LIMITS, assistantModelName, groupModelsByFamily, type AgentMemoryItem, type AssistantModelGroup, type MyAgent } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { SettingsBack } from '../app/SettingsBack';
import { MayDoChoice } from '../agent-connection/MayDoChoice';
import { refreshAssistantModel, useAssistantModel } from '../assistant/model';
import { Button, Icon, Kreska, Option, OptionGroup, Select, Spinner } from '../ui';
import { readKeyModelsAgain, setKeyModelPrice } from '../ai/api';
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

/** "$4" from micro-dollars, for a price the owner types. */
const dollars = (value: string) => {
  const number = Number(value.trim());
  return value.trim() && Number.isFinite(number) && number >= 0 && number <= 1000 ? Math.round(number * 1_000_000) : null;
};

/** "Input $2, output $10 per 1M tokens" as the Connect AI window words a model's price, "$2 / $10" (F-026 §7: "Claude Opus 5.5 · $4 / $20"). */
const shortPrice = (note: string) => {
  const found = /^Input (\$[\d.,]+), output (\$[\d.,]+) per 1M tokens$/.exec(note);
  return found ? `${found[1]} / ${found[2]}` : note;
};

/**
 * An API key's models on an agent (CA-2, #1218): one dropdown by family, newest first, each with its price, "Price unknown, enter
 * it" (choosing it asks for the price first, then chooses it) or "no longer offered" (not choosable). A list that couldn't be
 * read says so with Try again; the saved model stays.
 */
function KeyModels({ group, chosen, agentName, onChoose, onError }: {
  group: AssistantModelGroup; chosen: string | null; agentName: string; onChoose: (model: string) => Promise<void>; onError: (cause: unknown) => void;
}) {
  const [pricing, setPricing] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const company = group.company;
  const current = chosen ? group.options.find((option) => option.id === chosen) : undefined;
  // A model its provider stopped offering is listed only on the agent that is on it: there it says why the agent is paused.
  const families = groupModelsByFamily(group.options.filter((option) => !option.retired || option.id === chosen).map((option) => ({ ...option, family: option.family ?? 'Models' })));
  const priceFor = pricing ? group.options.find((option) => option.id === pricing) : undefined;

  async function savePrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const inputMicros = dollars(input);
    const outputMicros = dollars(output);
    if (!pricing || inputMicros === null || outputMicros === null) { setProblem('Enter both prices in US dollars per 1M tokens, from 0 to 1,000.'); return; }
    setBusy(true); setProblem('');
    try {
      await setKeyModelPrice(group.connection, { model: pricing, inputMicrosPerMTok: inputMicros, outputMicrosPerMTok: outputMicros });
      await onChoose(pricing);
      setPricing(null); setInput(''); setOutput('');
    } catch (cause) { onError(cause); }
    finally { setBusy(false); }
  }
  async function tryAgain() {
    setBusy(true);
    try { await readKeyModelsAgain(group.connection); await refreshAssistantModel(); }
    catch (cause) { onError(cause); }
    finally { setBusy(false); }
  }
  const listing = group.listing;
  return (
    <div className="agp__key-models">
      <Select aria-labelledby={`model-${group.connection}`} value={pricing ?? chosen ?? ''} placeholder="Choose a model" disabled={busy}
        onChange={(next) => {
          const option = group.options.find((item) => item.id === next);
          if (!option || next === chosen) return;
          if (option.priced === false) { setPricing(next); setProblem(''); return; }
          setPricing(null);
          void onChoose(next);
        }}>
        {families.map((family) => (
          <OptionGroup key={family.family} label={family.family}>
            {family.models.map((option) => (
              <Option key={option.id} value={option.id} disabled={option.retired}>
                {option.name} · {option.retired ? `no longer offered by ${company}` : shortPrice(option.note)}
              </Option>
            ))}
          </OptionGroup>
        ))}
      </Select>
      {current?.retired ? <p className="agp__hint" role="note">{current.name} is {`no longer offered by ${company}`}. {agentName} is paused until you choose another model.</p> : null}
      {group.options.some((option) => option.priced !== false && !option.retired) ? <p className="agp__hint">Prices are US dollars per 1M tokens, input / output.</p> : null}
      {pricing && priceFor ? (
        <form className="agp__price" onSubmit={(event) => void savePrice(event)} aria-label={`Price of ${priceFor.name}`}>
          <p className="agp__hint">Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget.</p>
          <div className="agp__price-fields">
            <label>Input, USD per 1M tokens<input className="agp__input" name="inputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" required
              value={input} onChange={(event) => setInput(event.target.value)} /></label>
            <label>Output, USD per 1M tokens<input className="agp__input" name="outputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" required
              value={output} onChange={(event) => setOutput(event.target.value)} /></label>
          </div>
          {problem ? <p className="agp__hint" role="alert">{problem}</p> : null}
          <div className="agp__price-actions">
            <Button type="submit" busy={busy}>Save price</Button>
            <Button variant="quiet" onClick={() => { setPricing(null); setProblem(''); }}>Cancel</Button>
          </div>
        </form>
      ) : null}
      {listing && (listing.state === 'unavailable' || listing.state === 'key_refused') ? (
        <p className="agp__hint agp__listing" role="status">
          {listing.state === 'key_refused' ? `${company} refused this key when Flux last read its models.` : `Couldn’t read ${company}’s model list.`}
          <Button variant="link" size="sm" busy={busy} onClick={() => void tryAgain()}>Try again</Button>
        </p>
      ) : null}
    </div>
  );
}

/** A plan with at most this many models keeps them as segments (the few of a Claude plan); more, the app's Select (#1332). */
const PLAN_SEGMENTS = 4;

/**
 * A plan's models on an agent (CA-2, #1332): exactly what the signed-in CLI lists, in its order and under its names. Up to four stay
 * segments; more, or an agent on a model the plan stopped offering, get the app's Select, where that model reads "no longer offered by
 * Claude" and cannot be chosen, with the line that says the agent is paused. A plan whose list was never read says so.
 */
function PlanModelChoice({ group, chosen, agentName, onChoose }: { group: AssistantModelGroup; chosen: string | null; agentName: string; onChoose: (model: string) => void }) {
  // A model the plan's list does not hold at all (a list read after a new sign-in, or a Codex model Flux has not reviewed) is no longer offered
  // either: the agent is paused on it just the same (#1332), so it reads the same way.
  // The CLI's own default (no model, or the engine's label) is never one of them.
  const offered = group.options.filter((option) => !option.retired);
  const listed = chosen ? group.options.find((option) => option.id === chosen) : undefined;
  const unlisted = !listed && !!chosen && chosen !== 'claude-code' && chosen !== 'codex' && offered.length > 0;
  const current = unlisted ? { id: chosen, name: assistantModelName(chosen), note: '', callsTools: true, retired: true } : listed;
  const options = unlisted ? [...group.options, current!] : group.options;
  if (!group.options.length) return <p className="agp__hint" role="note">Flux hasn’t read this plan’s models yet. It reads them when you sign in and again every few hours.</p>;
  if (offered.length <= PLAN_SEGMENTS && !current?.retired) {
    return (
      <div className="seg seg--fit" role="radiogroup" aria-labelledby={`model-${group.connection}`}>
        {offered.map((option, index) => {
          const on = chosen === option.id;
          // With none on (the CLI's own default), the first is the one the keyboard reaches.
          const reached = on || (index === 0 && !offered.some((item) => item.id === chosen));
          return (
            <button key={option.id} type="button" role="radio" className="seg__b" aria-checked={on} tabIndex={reached ? 0 : -1} data-model={option.id} data-connection={group.connection}
              onClick={() => { if (!on) onChoose(option.id); }}>{option.name}</button>
          );
        })}
      </div>
    );
  }
  const retired = `no longer offered by ${group.company}`;
  return (
    <div className="agp__key-models">
      <Select aria-labelledby={`model-${group.connection}`} value={chosen ?? ''} placeholder="Choose a model" onChange={(next) => { if (next !== chosen) onChoose(next); }}>
        {options.filter((option) => !option.retired || option.id === chosen).map((option) => (
          <Option key={option.id} value={option.id} disabled={option.retired}>{option.name}{option.retired ? ` · ${retired}` : option.note ? ` · ${option.note}` : ''}</Option>
        ))}
      </Select>
      {current?.retired ? <p className="agp__hint" role="note">{current.name} is {retired}. {agentName} is paused until you choose another model.</p> : null}
    </div>
  );
}

export function AgentPage() {
  const { agentId = '' } = useParams();
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div className="pane-scroll"><div className="pane-in nset agp">
        <SettingsBack />
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
      <SettingsBack />
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
                {item.account === 'api_key' ? (
                  <KeyModels group={item} chosen={agent.model.connection === item.connection ? agent.model.model : null} agentName={agent.name}
                    onChoose={(model) => save({ connection: item.connection, model }, 'Model changed')} onError={(cause) => setError(failure(cause))} />
                ) : (
                  <PlanModelChoice group={item} chosen={agent.model.connection === item.connection ? agent.model.model : null} agentName={agent.name}
                    onChoose={(model) => void save({ connection: item.connection, model }, 'Model changed')} />
                )}
              </div>
            ))}
            {picked && !picked.callsTools ? <p className="agp__hint" role="note">{picked.name}: can answer but can’t make changes.</p> : null}
            {picked && picked.seesPictures === false ? <p className="agp__hint" role="note">{picked.name}: can’t see pictures, so it sees attached files only by name.</p> : null}
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
        <Button variant="secondary" onClick={stop}>Cancel</Button>
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
