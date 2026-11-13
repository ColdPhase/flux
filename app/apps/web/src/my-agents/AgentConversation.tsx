import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { AgentChatMessage, AssistantRun, MyAgent } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useShellData } from '../app/data';
import { MessageDay, clock, day } from '../app/messageParts';
import { NewBelow, UnreadDivider, countBelow, openAtUnread, useNewBelow } from '../app/unreadReading';
import { AnswerBody, AnswerTools, WritingWords } from '../assistant/ConversationParts';
import { shownWords, stepWords, useForgetLiveRun, useLiveRun, useReducedMotion } from '../assistant/liveRun';
import { MessageText } from '../app/MessageText';
import { undoRunChanges } from '../assistant/api';
import { askError, askState, canRetry, endedText, isWorking, workingText } from '../assistant/format';
import { MessageBubble, PhotoGrid } from '../composer/Attachments';
import { ComposerBox } from '../composer/ComposerBox';
import { ConnectionLine } from '../composer/Outbox';
import { Button, Icon, Kreska, MEDIA, sendsOnEnter, useArrivals, useMediaQuery } from '../ui';
import { ReadySchedule, ScheduleHeader } from './AgentSchedules';
import { useAgentChat, type AgentChat } from './useAgentChat';
import { useAgentSchedules, type AgentSchedulesState } from './useAgentSchedules';
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

/** A chat's answers cite nothing of a space: the sources it names (none, for a schedule's result) have no project to open. */
const NO_LOOKUPS = { projectId: '', messages: [], work: new Map(), author: () => '' };

/** The lookups of a chat's answers with the names it knows (the owner and the people they message), so `@Ben Okafor` is one chip, not "Ben" and a word. */
function useChatLookups() {
  const { me, directMessages } = useShellData();
  return useMemo(() => ({ ...NO_LOOKUPS, people: [...new Set([me.user.name, ...directMessages.flatMap((dm) => dm.people)])].map((name) => ({ kind: 'human' as const, name })) }), [me.user.name, directMessages]);
}

/** One turn: what the owner said, then what the agent is doing or answered. */
function Turn({ run, agent, chat, schedules, first, newDay }: { run: AssistantRun; agent: MyAgent; chat: AgentChat; schedules: AgentSchedulesState; first: boolean; newDay: boolean }) {
  const lookups = useChatLookups();
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setFailed('');
    try { await action(); } catch (cause) { setFailed(cause instanceof NetworkError ? 'Offline' : cause instanceof ApiError && cause.message ? cause.message : 'Couldn’t reach Flux. Try again.'); }
    finally { setBusy(''); }
  };
  const working = isWorking(run);
  const ended = !working && !run.answer ? endedText(run) : null;
  // The answer as it is written (#1248): its words grow in the bubble, and before them the line names the step the agent is on.
  const live = useLiveRun(working ? run.id : null);
  const reduced = useReducedMotion();
  useForgetLiveRun(run.id, !working);
  const writing = working && run.status === 'dispatching' && !!live.text.trim();
  const step = working && run.status === 'dispatching' && !run.stopRequested ? stepWords(live.step) : null;
  const prepared = run.answer ? schedules.jobs?.find((job) => job.preparedRunId === run.id) ?? null : null;
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
            {/* The pictures the agent attached to its answer (#1217), as a message's photos: above its words. */}
            {run.answer && run.pictures?.length ? <PhotoGrid photos={run.pictures} context={{ author: agent.name }} /> : null}
            {run.answer ? <MessageBubble><div className="dm-msg__body agc__answer"><AnswerBody answer={run.answer} lookups={lookups} /></div></MessageBubble>
              : writing ? <MessageBubble><div className="dm-msg__body agc__answer" data-writing-run={run.id} aria-busy="true"><WritingWords words={shownWords(live.text, reduced)} reduced={reduced} people={lookups.people} /></div></MessageBubble>
                : <div className="dm-msg__body agc__state" data-run-status={run.status}>{working ? step ?? workingText(run) : ended ?? 'Nothing to say.'}</div>}
            {prepared ? <ReadySchedule job={prepared} state={schedules} agent={agent} /> : null}
            {run.answer?.truncated ? <p className="assistant-answer__truncated"><Icon name="alert" size={13} />Stopped at the length limit, so this answer is incomplete.</p> : null}
            {run.answer && run.status === 'stopped' ? <p className="assistant-answer__truncated" data-stopped-answer=""><Icon name="alert" size={13} />Stopped by you, so this answer is incomplete.</p> : null}
            {run.answer ? <AnswerTools answer={run.answer} onRetry={() => chat.retry(run)} /> : null}
            <div className="agc__actions">
              {working && !run.stopRequested ? <Button variant="outline" icon="stop" busy={busy === 'stop'} onClick={() => void act('stop', () => chat.stop(run))}>Stop</Button> : null}
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

/**
 * A schedule's result in the chat, as drawn (mockup AgentReports, phone "Assistant · 9:00 · Every weekday 9:00"): one message of the agent, said once,
 * with the schedule's name and times after its own. A firing that gave no result says why in a muted line (C-53), with the way to fix a sign-out.
 */
function ScheduleLine({ line, schedule, agent, newDay }: { line: AgentChatMessage; schedule: NonNullable<AgentChatMessage['schedule']>; agent: MyAgent; newDay: boolean }) {
  const lookups = useChatLookups();
  return (
    <li className="dm-msg agc__turn" data-line-id={line.id} data-schedule-line={schedule.failed ? 'failed' : 'result'} data-chat-agent="">
      {newDay ? <MessageDay as="p" label={day(line.createdAt)} /> : null}
      <div className="dm-msg__row">
        <span className="dm-msg__face"><Kreska size={26} hue={agent.colour} /></span>
        <div className="dm-msg__main">
          {/* One line, as drawn ("Assistant · 9:00 · Every weekday 9:00"): the rest is one item that is cut with an ellipsis rather than broken into columns. */}
          <p className="dm-msg__meta agc__meta"><b>{agent.name}</b><span className="agc__meta-rest" title={`${schedule.words} · ${schedule.title}`}>· <time className="agc__time" dateTime={line.createdAt}>{clock(line.createdAt)}</time> · {schedule.words} · {schedule.title}</span></p>
          {schedule.failed ? (
            <div className="agc__line agc__line--failed">
              <Icon name="alert" size={13} />
              <span>{line.body}</span>
              {/^Sign in to /.test(line.body) ? <Link className="ui-btn ui-btn--quiet ui-btn--sm" to="/settings/agents">Sign in</Link> : null}
            </div>
          ) : <MessageBubble><div className="dm-msg__body agc__answer"><AnswerBody answer={{ body: line.body, sources: [] }} lookups={lookups} /></div></MessageBubble>}
        </div>
      </div>
    </li>
  );
}

/** One line the agent said on its own: a schedule's result, or the report of its work. */
function Line({ line, agent, newDay, onChanged }: { line: AgentChatMessage; agent: MyAgent; newDay: boolean; onChanged: () => void }) {
  return line.schedule ? <ScheduleLine line={line} schedule={line.schedule} agent={agent} newDay={newDay} /> : <ReportLine line={line} agent={agent} newDay={newDay} onChanged={onChanged} />;
}

/**
 * One report of the agent's work (#842, #919; mockup AgentReports): its own words and the task chip, then the muted change line under them,
 * "Done: #4 … · 3 changes · Undo". Undo reverses the changes of the run this line reports, the same call as the change line of a task's
 * discussion (#856); once nothing stands the line is struck through and says "Undone by you".
 */
function ReportLine({ line, agent, newDay, onChanged }: { line: AgentChatMessage; agent: MyAgent; newDay: boolean; onChanged: () => void }) {
  const lookups = useChatLookups();
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const undo = async () => {
    if (!line.runId) return;
    setUndoing(true); setFailed(false); setNote('');
    try {
      const result = await undoRunChanges(line.runId);
      // What changed since is not taken back: say which, as a task's change line does.
      if (result.changedSince.length) setNote(result.message);
      onChanged();
    } catch { setFailed(true); } finally { setUndoing(false); }
  };
  const total = line.changes + line.undone;
  const count = total ? ` · ${total} ${total === 1 ? 'change' : 'changes'}` : '';
  const undone = total > 0 && line.changes === 0;
  return (
    <li className="dm-msg agc__turn" data-line-id={line.id} data-run-id={line.runId} data-chat-agent="">
      {newDay ? <MessageDay as="p" label={day(line.createdAt)} /> : null}
      <div className="dm-msg__row">
        <span className="dm-msg__face"><Kreska size={26} hue={agent.colour} /></span>
        <div className="dm-msg__main">
          <p className="dm-msg__meta"><b>{agent.name}</b><time className="agc__time" dateTime={line.createdAt}> · {clock(line.createdAt)}</time></p>
          {line.words || line.task ? (
            <MessageBubble><div className="dm-msg__body agc__answer">
              {line.words ? <div className="assistant-answer__body"><MessageText body={line.words} people={lookups.people} /></div> : null}
              {line.task ? (
                <Link className="agc__chip" to={`/projects/${line.task.projectId}/tasks?open=work:${line.task.id}`}>
                  <Icon name="tasks" size={13} />#{line.task.number} {line.task.title} · {line.task.projectName}
                </Link>
              ) : null}
            </div></MessageBubble>
          ) : null}
          <div className="agc__line">
            <Icon name="check" size={13} />
            <span>{undone ? <><s>{line.body}{count}</s> · <b>Undone by you</b></> : <>{line.body}{count}</>}</span>
            {line.changes > 0 ? <Button variant="quiet" size="sm" busy={undoing} onClick={() => void undo()}>Undo</Button> : null}
          </div>
          {note ? <p className="agc__line-note" role="status">{note}</p> : null}
          {failed ? <p className="agc__line-note" role="alert">Could not undo. Try again.</p> : null}
        </div>
      </div>
    </li>
  );
}

function AgentChatPane({ agent }: { agent: MyAgent }) {
  const touch = useMediaQuery(MEDIA.touch);
  // On the phone the shell's title row is the chat's header (Back, its face, its name and "Your agent · only you talk to it", #1356): the
  // bar and the lock line below would say the same again.
  const phone = useMediaQuery(MEDIA.phone);
  const { me } = useShellData();
  const chat = useAgentChat(agent.id, me.user.id);
  const schedules = useAgentSchedules(agent.id, chat.version, chat.refresh);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const feed = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement>(null);
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((node: HTMLDivElement | null) => { feed.current = node; setFeedNode(node); }, []);
  const field = useRef<HTMLTextAreaElement>(null);
  const state = askState(chat.status);
  // What was said, in the order it happened: the owner's words with their answers, and the agent's own lines.
  const entries = [...(chat.runs ?? []).map((run) => ({ at: run.createdAt, key: `run-${run.id}`, run, line: null as AgentChatMessage | null })),
    ...chat.lines.map((line) => ({ at: line.createdAt, key: `line-${line.id}`, run: null as AssistantRun | null, line }))].sort((a, b) => a.at.localeCompare(b.at));
  const count = entries.length;
  const working = chat.working;
  // Where the person left off (#1246): the first thing the agent said after they last had this chat open, as it was when they opened it
  // (later things are not "new" to a chat that is open: it reads itself as they arrive).
  // A chat never opened has all of what the agent said to read: the first of it.
  const since = chat.opening?.since ?? '';
  const [newFrom, setNewFrom] = useState<string | null | undefined>(undefined);
  if (newFrom === undefined && chat.opening) {
    setNewFrom(entries.find((entry) => entry.run ? (entry.run.completedAt ?? '') > since : entry.line!.createdAt > since)?.key ?? null);
  }
  // Opening is on the "New" divider, or on the newest turn. After that the newest turn comes into view as it arrives or changes only for a
  // reader who is at the end; one who is reading above is never moved, and what arrives is counted in "↓ N new".
  // Whether the reader is at the end is read from where they are now against where the feed ended after the last render: not from a flag that
  // scroll events keep, which is a frame behind a scroll (a turn that arrives in that frame would pull a reader who has just scrolled up back down).
  // While the agent writes its answer (#1248), its growing words count as a change too: the chat follows them for a reader at the end.
  const writingRun = (chat.runs ?? []).find((run) => isWorking(run))?.id ?? null;
  const growing = useLiveRun(writingRun).text.length;
  const lastHeight = useRef(0);
  const forced = useRef(false);
  const placed = useRef(false);
  const stopUnread = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !chat.opening || newFrom === undefined) return;
    if (!placed.current) {
      placed.current = true;
      stopUnread.current = newFrom ? openAtUnread(el, column.current) : null;
      if (!stopUnread.current) el.scrollTop = el.scrollHeight;
      lastHeight.current = el.scrollHeight;
      return;
    }
    const atEnd = el.scrollTop + el.clientHeight >= lastHeight.current - 48;
    if (forced.current || atEnd) el.scrollTop = el.scrollHeight;
    forced.current = false;
    lastHeight.current = el.scrollHeight;
  }, [count, working, chat.opening, newFrom, growing]);
  useEffect(() => () => stopUnread.current?.(), []);
  useEffect(() => {
    if (!feedNode) return;
    // The height the feed has when the reader scrolls: layout that changes it between renders (a long answer settling) is not the reader's to be moved by.
    const track = () => { lastHeight.current = feedNode.scrollHeight; };
    feedNode.addEventListener('scroll', track, { passive: true });
    return () => feedNode.removeEventListener('scroll', track);
  }, [feedNode]);
  const newBelow = useNewBelow(feedNode);
  const elementFor = (key: string) => feed.current?.querySelector<HTMLElement>(key.startsWith('run-') ? `[data-run-id="${key.slice(4)}"][data-chat-agent]` : `[data-line-id="${key.slice(5)}"]`) ?? null;
  useArrivals(feed, entries.map((entry) => entry.key), elementFor, (keys, atEnd) => {
    if (!atEnd) newBelow.add(countBelow(feed.current, keys, elementFor));
  }, { animate: false });
  useLayoutEffect(() => { const el = field.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; } }, [draft]);
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, [agent.id]);

  async function send() {
    const prompt = draft.trim();
    if (!prompt || sending) return;
    if (state.kind !== 'ready') { setError(state.note); return; }
    setSending(true); setError('');
    // What the person sends is theirs to see at once, wherever they were reading.
    forced.current = true;
    try { await chat.send(prompt); setDraft(''); }
    catch (cause) { setError(askError(cause)); }
    finally { setSending(false); requestAnimationFrame(() => field.current?.focus({ preventScroll: true })); }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); } };

  return (
    <div className="dm agc-pane" data-agent-conversation={agent.id}>
      {/* The agent's bar and its schedules line stay above the history, so the line is in view whatever the chat holds (the drawing has it in the header). */}
      <div className="agc__top">
        <div className="dm__in agc">
          {phone ? null : (
            <div className="agc__bar">
              <span className="agc__who"><Kreska size={24} hue={agent.colour} /><b>{agent.name}</b><span className="agc__tag">Your agent</span></span>
              <Link className="ui-link agc__settings" to={`/settings/agents/${agent.id}`}>Settings</Link>
            </div>
          )}
          <ScheduleHeader agent={agent} state={schedules} />
        </div>
      </div>
      <div className="convo-stream">
      <div className="dm__feed" ref={attachFeed}>
        <div className="dm__in agc" ref={column}>
          {phone ? null : <p className="agc__note"><Icon name="lock" size={13} />Only you talk to {agent.name}. Reports of its work arrive here.</p>}
          {chat.runs === null ? (chat.failed ? <p className="agc__empty" role="alert">Couldn’t read this chat. <button type="button" className="ui-link" onClick={chat.refresh}>Try again</button></p> : null)
            : entries.length ? (
              <ol className="dm__list" aria-label={`Your chat with ${agent.name}`}>
                {entries.flatMap((entry, index) => {
                  const previous = entries[index - 1];
                  const newDay = !previous || day(previous.at) !== day(entry.at);
                  const item = entry.run ? <Turn key={entry.run.id} run={entry.run} agent={agent} chat={chat} schedules={schedules} first newDay={newDay && entry.key !== newFrom} />
                    : <Line key={entry.line!.id} line={entry.line!} agent={agent} newDay={newDay && entry.key !== newFrom} onChanged={chat.refresh} />;
                  // Where what is new begins (#1246): its day line first, then the divider, then what the agent said.
                  return entry.key === newFrom ? [newDay ? <MessageDay key={`day-${entry.key}`} label={day(entry.at)} /> : null, <UnreadDivider key="unread" />, item] : item;
                })}
              </ol>
            ) : <p className="agc__empty">Nothing here yet. Say what you want {agent.name} to do, or ask it something.</p>}
        </div>
      </div>
      <NewBelow count={newBelow.count} onClick={newBelow.toEnd} />
      </div>
      <div className="composer dm__composer">
        <div className="composer__in">
          <ConnectionLine />
          <ComposerBox id="agent-composer" label={`Message ${agent.name}`} fieldRef={field} value={draft} placeholder={[`Message ${agent.name}`, 'Message']}
            onChange={(value) => { setDraft(value); setError(''); }} onKeyDown={onKey} disabled={sending} boxDisabled={sending}
            sendLabel={`Send to ${agent.name}`} sendDisabled={!draft.trim() || sending} onSend={() => void send()} />
          {state.kind === 'blocked' && chat.status ? <p className="composer__audience" role="status"><Icon name="alert" size={13} /><span>{state.note}</span></p> : null}
          {error ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
