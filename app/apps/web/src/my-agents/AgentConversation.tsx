import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { AgentChatMessage, AssistantRun, MyAgent } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useShellData } from '../app/data';
import { MessageDay, clock, day } from '../app/messageParts';
import { AnswerBody } from '../assistant/ConversationParts';
import { undoRunChanges } from '../assistant/api';
import { askError, askState, canRetry, endedText, isWorking, workingText } from '../assistant/format';
import { MessageBubble } from '../composer/Attachments';
import { ComposerBox } from '../composer/ComposerBox';
import { ConnectionLine } from '../composer/Outbox';
import { Button, Icon, Kreska, MEDIA, sendsOnEnter, useMediaQuery } from '../ui';
import { useAgentChat, type AgentChat } from './useAgentChat';
import '../dm/dm.css';
import './my-agents.css';

/**
 * An agent as a private conversation in Messages (F-036 AG-4, #857, #842; mockup AgentReports): its header, the line that only its owner
 * talks to it, what was said, and the box to say more. Each message is a run of the agent: the answer arrives here and nowhere else.
 */
export function AgentConversation() {
  const { agentId = '' } = useParams();
  const { agents } = useShellData();
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div className="pane-scroll"><div className="pane-in agc">
        <p className="agc__note">This agent isn’t here. It may have been deleted. <Link className="ui-link" to="/dm">Back to Messages</Link></p>
      </div></div>
    );
  }
  return <AgentChatPane key={agent.id} agent={agent} />;
}

/** One turn: what the owner said, then what the agent is doing or answered. */
function Turn({ run, agent, chat, first, newDay }: { run: AssistantRun; agent: MyAgent; chat: AgentChat; first: boolean; newDay: boolean }) {
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setFailed('');
    try { await action(); } catch (cause) { setFailed(cause instanceof NetworkError ? 'Offline' : cause instanceof ApiError && cause.message ? cause.message : 'Couldn’t reach Flux. Try again.'); }
    finally { setBusy(''); }
  };
  const working = isWorking(run);
  const ended = !working && !run.answer ? endedText(run) : null;
  return (
    <>
      <li className="dm-msg is-mine agc__turn" data-run-id={run.id} data-chat-me="">
        {newDay ? <MessageDay as="p" label={day(run.createdAt)} /> : null}
        <div className="dm-msg__row"><div className="dm-msg__main is-mine"><MessageBubble><div className="dm-msg__body">{run.prompt}</div></MessageBubble></div></div>
      </li>
      <li className="dm-msg agc__turn" data-run-id={run.id} data-chat-agent="" aria-live="polite">
        <div className="dm-msg__row">
          <span className="dm-msg__face"><Kreska size={26} hue={agent.colour} /></span>
          <div className="dm-msg__main">
            {first ? <p className="dm-msg__meta"><b>{agent.name}</b></p> : null}
            {run.answer ? <MessageBubble><div className="dm-msg__body agc__answer"><AnswerBody answer={run.answer} lookups={{ projectId: '', messages: [], work: new Map(), author: () => '' }} /></div></MessageBubble>
              : <div className="dm-msg__body agc__state" data-run-status={run.status}>{working ? workingText(run) : ended ?? 'Nothing to say.'}</div>}
            {run.answer?.truncated ? <p className="assistant-answer__truncated"><Icon name="alert" size={13} />Stopped at the length limit, so this answer is incomplete.</p> : null}
            <div className="agc__actions">
              {working && !run.stopRequested ? <Button variant="quiet" busy={busy === 'stop'} onClick={() => void act('stop', () => chat.stop(run))}>Stop</Button> : null}
              {!working && !run.answer && canRetry(run) ? <Button variant="quiet" busy={busy === 'retry'} onClick={() => void act('retry', () => chat.retry(run))}>Try again</Button> : null}
              {!working && run.endReason === 'sign_in_again' ? <Link className="ui-btn ui-btn--quiet" to="/settings/agents">Sign in</Link> : null}
              {!working && run.endReason === 'model_unavailable' ? <Link className="ui-btn ui-btn--quiet" to={`/settings/agents/${agent.id}`}>Choose a model</Link> : null}
              {!working ? <time className="agc__time" dateTime={run.completedAt ?? run.createdAt}>{clock(run.completedAt ?? run.createdAt)}</time> : null}
            </div>
            {failed ? <p className="assistant-answer__error" role="alert">{failed}</p> : null}
          </div>
        </div>
      </li>
    </>
  );
}

/** One line the agent said on its own: the report of a run (#842, AG-7). */
function Line({ line, agent, newDay, onChanged }: { line: AgentChatMessage; agent: MyAgent; newDay: boolean; onChanged: () => void }) {
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState(false);
  // Undo reverses the changes of the run this line reports, the same call as the change line of a task's discussion (#856).
  const undo = async () => {
    setUndoing(true); setFailed(false);
    try { await undoRunChanges(line.runId); onChanged(); } catch { setFailed(true); } finally { setUndoing(false); }
  };
  return (
    <li className="dm-msg agc__turn" data-line-id={line.id} data-run-id={line.runId} data-chat-agent="">
      {newDay ? <MessageDay as="p" label={day(line.createdAt)} /> : null}
      <div className="dm-msg__row">
        <span className="dm-msg__face"><Kreska size={26} hue={agent.colour} /></span>
        <div className="dm-msg__main">
          <p className="dm-msg__meta"><b>{agent.name}</b></p>
          <MessageBubble><div className="dm-msg__body agc__answer"><p>{line.body}{line.changes > 0 ? ` · ${line.changes} ${line.changes === 1 ? 'change' : 'changes'}` : ''}</p></div></MessageBubble>
          <div className="agc__actions">
            <time className="agc__time" dateTime={line.createdAt}>{clock(line.createdAt)}</time>
            {line.changes > 0 ? <Button variant="quiet" size="sm" busy={undoing} onClick={() => void undo()}>Undo</Button> : null}
            {failed ? <span role="alert">Could not undo. Try again.</span> : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function AgentChatPane({ agent }: { agent: MyAgent }) {
  const touch = useMediaQuery(MEDIA.touch);
  const { me } = useShellData();
  const chat = useAgentChat(agent.id, me.user.id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const state = askState(chat.status);
  // What was said, in the order it happened: the owner's words with their answers, and the agent's own lines.
  const entries = [...(chat.runs ?? []).map((run) => ({ at: run.createdAt, run, line: null as AgentChatMessage | null })),
    ...chat.lines.map((line) => ({ at: line.createdAt, run: null as AssistantRun | null, line }))].sort((a, b) => a.at.localeCompare(b.at));
  const count = entries.length;
  const working = chat.working;
  // The newest turn is in view when the chat opens and whenever one arrives or changes.
  useLayoutEffect(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; }, [count, working]);
  useLayoutEffect(() => { const el = field.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; } }, [draft]);
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, [agent.id]);

  async function send() {
    const prompt = draft.trim();
    if (!prompt || sending) return;
    if (state.kind !== 'ready') { setError(state.note); return; }
    setSending(true); setError('');
    try { await chat.send(prompt); setDraft(''); }
    catch (cause) { setError(askError(cause)); }
    finally { setSending(false); requestAnimationFrame(() => field.current?.focus({ preventScroll: true })); }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); } };

  return (
    <div className="dm agc-pane" data-agent-conversation={agent.id}>
      <div className="dm__feed" ref={feed}>
        <div className="dm__in agc">
          <div className="agc__bar">
            <span className="agc__who"><Kreska size={24} hue={agent.colour} /><b>{agent.name}</b><span className="agc__tag">Your agent</span></span>
            <Link className="ui-link agc__settings" to={`/settings/agents/${agent.id}`}>Settings</Link>
          </div>
          <p className="agc__note"><Icon name="lock" size={13} />Only you talk to {agent.name}. Reports of its work arrive here.</p>
          {chat.runs === null ? (chat.failed ? <p className="agc__empty" role="alert">Couldn’t read this chat. <button type="button" className="ui-link" onClick={chat.refresh}>Try again</button></p> : null)
            : entries.length ? (
              <ol className="dm__list" aria-label={`Your chat with ${agent.name}`}>
                {entries.map((entry, index) => {
                  const previous = entries[index - 1];
                  const newDay = !previous || day(previous.at) !== day(entry.at);
                  return entry.run ? <Turn key={entry.run.id} run={entry.run} agent={agent} chat={chat} first newDay={newDay} />
                    : <Line key={entry.line!.id} line={entry.line!} agent={agent} newDay={newDay} onChanged={chat.refresh} />;
                })}
              </ol>
            ) : <p className="agc__empty">Nothing here yet. Say what you want {agent.name} to do, or ask it something.</p>}
        </div>
      </div>
      <div className="composer dm__composer">
        <div className="composer__in">
          <ConnectionLine />
          <ComposerBox id="agent-composer" label={`Message ${agent.name}`} fieldRef={field} value={draft} placeholder={`Message ${agent.name}`}
            onChange={(value) => { setDraft(value); setError(''); }} onKeyDown={onKey} disabled={sending} boxDisabled={sending}
            sendLabel={`Send to ${agent.name}`} sendDisabled={!draft.trim() || sending} onSend={() => void send()} />
          {state.kind === 'blocked' && chat.status ? <p className="composer__audience" role="status"><Icon name="alert" size={13} /><span>{state.note}</span></p> : null}
          {error ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
