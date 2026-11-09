import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AssistantChange, ConversationMessage, NamedPrincipal, ObjectLink, Project, TaskActivityEntry, TaskDiscussion as Discussion, WorkItem, WorkspaceMember } from '@flux/contracts';
import { AgentIdentity, Avatar, Button, Kreska, MEDIA, sendsOnEnter, useMediaQuery } from '../ui';
import { useComposerScope, type useComposerDraft } from '../composer/draft';
import { ComposerFiles, MessageContent, hasPhotos } from '../composer/Files';
import { ComposerAudience, ComposerBox } from '../composer/ComposerBox';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { ConnectionLine, OutboxStatus, PendingFiles, PendingSource, SendAnnouncer } from '../composer/Outbox';
import { ContributionMark, clock, day, when } from '../app/messageParts';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { useProjectShell } from '../project/data';
import { getTaskDiscussion } from '../composer/api';
import { agentDisplayName, FORMER_MEMBER } from '../docs/format';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { TaskAgentState } from '../agents/TaskAgentState';
import { failure, useAssistantChanges } from '../assistant/WaitingChanges';
import { askError, askState } from '../assistant/format';
import { PrivateAiLines, firstNames } from '../assistant/PrivateAiLines';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useSpaceAi } from '../ai/spaceAi';
import { undoChange } from '../assistant/api';
import { RefLink } from '../place/origin';
import { useCreateWorkFromMessage } from './inline';
import { getTaskActivity } from './api';
import { STATUS_LABEL } from './format';
import { dueLabel } from './TaskParts';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';

// A task's Activity (F-026 P10, #488): one timeline, newest first, of what changed and who said what. Each line has its
// real author and time: the task's creation, every change of its state, owner, due day and title that was recorded, and the
// messages of the task's one discussion. The composer sits at the bottom of the panel and writes to the same discussion.

type Source = 'message' | 'thought' | 'plan' | 'material' | 'doc' | null;
type Line =
  | { kind: 'created'; key: string; at: string; actor: NamedPrincipal; source: Source }
  | { kind: 'reverted'; key: string; at: string; actor: NamedPrincipal }
  | { kind: 'change'; key: string; at: string; entry: TaskActivityEntry }
  | { kind: 'message'; key: string; at: string; message: ConversationMessage };

export type TaskComposerDraft = ReturnType<typeof useComposerDraft>;

const MESSAGES = 20;

function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Where a task came from, said in one short phrase for its first line. */
function sourceOf(item: Pick<WorkItem, 'id' | 'planIntent'>, links: ObjectLink[]): Source {
  if (item.planIntent) return 'plan';
  const link = links.find((entry) => entry.from.id === item.id && entry.role === 'source');
  if (!link) return null;
  return link.to.type === 'message' ? 'message' : link.to.type === 'thought' ? 'thought' : link.to.type === 'material' ? 'material' : link.to.type === 'doc' ? 'doc' : null;
}

const FROM: Record<NonNullable<Source>, string> = {
  message: 'made it from a message', thought: 'made it from a thought on the map', plan: 'made it from a plan revision', material: 'made it from a source', doc: 'made it from a Wiki page',
};

/** The text after the actor's name; the actor and the time are shown beside it. */
function changeText(entry: TaskActivityEntry): string {
  const rule = entry.automation === 'github_rule' ? ' (a pull request rule)' : entry.automation === 'agent_rule' ? ' (the agent setting)'
    : entry.automation === 'wait_resolved' ? ' (what it waited for is resolved)' : '';
  if (entry.kind === 'status' && entry.status) {
    const { to, blocker, waitingFor, waitingOn, dropped } = entry.status;
    if (to === 'blocked') {
      const reason = [blocker, waitingFor ? `waiting for ${waitingFor.name}` : waitingOn ? `waiting for ${waitingOn}` : null].filter(Boolean).join(' · ');
      return `marked it blocked${reason ? `: ${reason}` : ''}${rule}`;
    }
    return to === 'done' && dropped ? `marked it done (dropped)${rule}` : `marked it ${STATUS_LABEL[to].toLowerCase()}${rule}`;
  }
  if (entry.kind === 'owner' && entry.owner) {
    const { from, to } = entry.owner;
    // The agent that held it was deleted: say so, rather than a reassignment by the setting (#1003).
    if (entry.automation === 'agent_deleted' && to) return `deleted the agent${from ? ` ${from.name}` : ''}, so it came back to ${to.name}`;
    if (!to) return `removed the owner${from ? ` (${from.name})` : ''}${rule}`;
    return `${to.kind === 'agent' ? 'handed it off to' : from ? 'reassigned it to' : 'assigned it to'} ${to.name}${rule}`;
  }
  if (entry.kind === 'due' && entry.due) {
    return entry.due.to ? `set it due ${dueLabel(entry.due.to)}${rule}` : `cleared the due date${rule}`;
  }
  if (entry.kind === 'title' && entry.title) return `renamed it to “${entry.title.to}”${rule}`;
  return `changed it${rule}`;
}

// The day is a word in the text face; only the clock is in Geist Mono (README §2: mono for times).
function stamp(at: string) { return <>{day(at)}, <span className="wd-act__clock">{clock(at)}</span></>; }
/** The name a line goes by: first names, as drawn; the full name is one hover away. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** What the timeline and the composer share: the task's discussion and its recorded changes, read together. */
export function useTaskActivity({ item, links, project, members, me, revision }: {
  item: Pick<WorkItem, 'id' | 'planIntent' | 'createdAt' | 'createdBy' | 'lifecycle'>; links: ObjectLink[]; project: Project; members: WorkspaceMember[]; me: { id: string; name: string }; revision: number | string;
}) {
  const people = useProjectShell()?.people ?? null;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [changes, setChanges] = useState<TaskActivityEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [failed, setFailed] = useState<'all' | 'changes' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busyEarlier, setBusyEarlier] = useState(false);
  // How many times the thread was read: the changes beside it are read again with it, because a line can change without a line coming or going.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([getTaskActivity(item.id, { signal: controller.signal }), getTaskDiscussion(item.id, { limit: MESSAGES, signal: controller.signal })]).then(([activity, talk]) => {
      if (controller.signal.aborted) return;
      if (activity.status === 'fulfilled') { setChanges(activity.value.items); setNextBefore(activity.value.nextBefore); }
      if (talk.status === 'fulfilled') {
        setDiscussion(talk.value);
        setMessages((current) => mergeMessages(current, [...(talk.value.root ? [talk.value.root] : []), ...talk.value.messages]));
      }
      setFailed(activity.status === 'rejected' && talk.status === 'rejected' ? 'all' : activity.status === 'rejected' ? 'changes' : null);
      setReads((value) => value + 1);
    });
    return () => controller.abort();
  }, [item.id, project.id, me.id, attempt, revision]);

  const oldest = messages[0];
  const olderMessages = !!discussion?.messagePage.hasMoreBefore && !!oldest && oldest.sequence > 1;
  const hasEarlier = !!nextBefore || olderMessages;
  const loadEarlier = useCallback(async () => {
    setBusyEarlier(true);
    try {
      const [more, older] = await Promise.all([
        nextBefore ? getTaskActivity(item.id, { before: nextBefore }) : Promise.resolve(null),
        olderMessages && oldest ? getTaskDiscussion(item.id, { limit: MESSAGES, beforeSequence: oldest.sequence }) : Promise.resolve(null),
      ]);
      if (more) { setChanges((current) => [...(current ?? []), ...more.items]); setNextBefore(more.nextBefore); }
      if (older) { setMessages((current) => mergeMessages(current, older.messages)); setDiscussion((current) => current && { ...current, messagePage: older.messagePage }); }
    } catch { setFailed('changes'); }
    finally { setBusyEarlier(false); }
  }, [item.id, nextBefore, olderMessages, oldest]);

  const author = useCallback((message: ConversationMessage) => {
    if (message.authorId === null) return agentDisplayName(message.author);
    if (message.authorId === me.id) return me.name;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? FORMER_MEMBER;
  }, [me.id, me.name, members, people]);

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const entry of changes ?? []) out.push({ kind: 'change', key: `change-${entry.id}`, at: entry.at, entry });
    for (const message of messages) {
      // The reason a task was blocked with is also contributed to its discussion; the change line already says it.
      const said = message.contribution?.kind === 'blocker' && (changes ?? []).some((entry) => entry.kind === 'status' && entry.status?.to === 'blocked'
        && Math.abs(Date.parse(entry.at) - Date.parse(message.createdAt)) < 15_000);
      if (!said) out.push({ kind: 'message', key: `message-${message.id}`, at: message.createdAt, message });
    }
    if (item.lifecycle?.state === 'creation_reverted') out.push({ kind: 'reverted', key: 'reverted', at: item.lifecycle.revertedAt, actor: item.lifecycle.revertedBy });
    // The task's creation is the oldest line, shown once nothing older is left to load.
    if (!hasEarlier) out.push({ kind: 'created', key: 'created', at: item.createdAt, actor: item.createdBy, source: sourceOf(item, links) });
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [changes, messages, item, links, hasEarlier]);

  // `/ai` in the task's discussion (#842): the person's own agent answers them alone; Show everyone posts the answer in the discussion.
  const { workspace } = useShellData();
  const aiOff = useSpaceAi(project.id).blocked || workspace?.role === 'guest';
  const assistant = useConversationAssistant({ meId: me.id, enabled: !aiOff, place: discussion?.conversationId ? { kind: 'space', projectId: project.id, conversationId: discussion.conversationId } : null,
    onShown: () => setAttempt((value) => value + 1) });

  return {
    discussion, lines, reads, loading: !discussion && changes === null && failed !== 'all', failed, hasEarlier, loadEarlier, busyEarlier, author, assistant, aiOff,
    retry: () => { setFailed(null); setAttempt((value) => value + 1); },
    reload: () => setAttempt((value) => value + 1),
  };
}

export type TaskActivityState = ReturnType<typeof useTaskActivity>;

function Face({ actor, mine }: { actor: { kind: 'agent' | 'human'; name: string }; mine: boolean }) {
  return actor.kind === 'agent' ? <Kreska size={20} className="wd-act__face" /> : <Avatar name={actor.name} size="sm" tone={mine ? 'me' : 'neutral'} />;
}

/**
 * What an agent's line in the thread is, as its run's change (#923, #938, TA-3): its owner can always delete it, whoever answered it
 * since, and everyone then reads "Removed by Jonas" over a marker that keeps the line's place. Asked once, because it cannot be taken back.
 */
function PostedLine({ change, onChanged }: { change: AssistantChange; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  if (change.state === 'undone') return <p className="assistant-message__line" role="status">Removed by {change.decidedBy?.name ?? 'its owner'}</p>;
  if (!change.undoable) return null;
  const remove = async () => {
    setBusy(true); setNote('');
    try { setNote((await undoChange(change)).message ?? ''); setAsking(false); } catch (error) { setNote(failure(error)); } finally { setBusy(false); onChanged(); }
  };
  return asking ? (
    <p className="assistant-message__line" role="group" aria-label="Delete this line?">
      <span>Delete this line for everyone?</span><span aria-hidden="true"> · </span>
      <Button variant="link" busy={busy} onClick={() => void remove()}>Delete</Button><span aria-hidden="true"> · </span>
      <Button variant="link" disabled={busy} onClick={() => setAsking(false)}>Keep</Button>
      {note ? <><span aria-hidden="true"> · </span><span role="status">{note}</span></> : null}
    </p>
  ) : (
    <p className="assistant-message__line">
      <Button variant="link" aria-label="Delete this line" onClick={() => { setNote(''); setAsking(true); }}>Delete</Button>
      {note ? <><span aria-hidden="true"> · </span><span role="status">{note}</span></> : null}
    </p>
  );
}

/** The timeline: newest first, each line with its author and time. */
export function ActivityTimeline({ state, composer, item, project, me, writable, composerId }: {
  state: TaskActivityState; composer: TaskComposerDraft; item: Pick<WorkItem, 'id' | 'version' | 'number' | 'title'>; project: Project; me: { id: string; name: string }; writable: boolean; composerId: string;
}) {
  const owners = useAgentOwners(project);
  const makeWork = useCreateWorkFromMessage(project);
  const { openDetails } = useShellActions();
  const headingId = useId();
  const { discussion } = state;
  const people = useProjectShell()?.people ?? null;
  const othersOf = firstNames((people ?? []).filter((person) => person.kind === 'human' && person.id !== me.id).map((person) => person.name));
  const thread = discussion?.conversationId ? `/projects/${project.id}/conversations/${discussion.conversationId}` : null;
  // An agent's line in this thread is its run's change: it is taken back where it stands, not in the state line above.
  const posts = useAssistantChanges(discussion?.conversationId ?? null, `${state.lines.length}:${state.reads}`);
  const posted = useMemo(() => {
    const byMessage = new Map<string, AssistantChange>();
    for (const runChanges of posts.byRun.values()) for (const change of runChanges) if (change.objectType === 'message' && change.operation === 'conversation.reply' && change.objectId) byMessage.set(change.objectId, change);
    return byMessage;
  }, [posts.byRun]);
  // A line an agent put in this thread is deleted where it stands, whichever page of the activity it is on, and not from the state line.
  const inThread = useCallback((change: AssistantChange) => change.objectType === 'message' && change.operation === 'conversation.reply', []);
  return (
    <section className="details__sec wd-activity" aria-labelledby={headingId}>
      <div className="wd-sechead">
        <h4 id={headingId}>Activity</h4>
        {thread ? <RefLink className="wd-inline wd-activity__open" to={thread} state={{ keepPanel: true }}>Open in Conversation</RefLink> : null}
      </div>
      {state.failed === 'all' ? <p className="wd-error" role="alert">The activity could not be loaded. <button type="button" className="wd-inline" onClick={state.retry}>Retry</button></p>
        : state.loading ? <p className="wd-muted" aria-busy="true">Loading…</p> : null}
      <TaskAgentState item={item} projectId={project.id} conversationId={discussion?.conversationId ?? null} revision={state.lines.length} onChanged={state.reload} elsewhere={inThread} />
      {/* The person's own agent at work and what it answered them: theirs alone (#842). */}
      <PrivateAiLines own assistant={state.assistant} meId={me.id} meName={me.name} others={othersOf} composerId={composerId}
        lookups={{ projectId: project.id, messages: [], work: new Map(), author: () => '' }} />
      {state.failed === 'changes' ? <p className="wd-error" role="alert">Some of the history could not be loaded. <button type="button" className="wd-inline" onClick={state.retry}>Retry</button></p> : null}
      {composer.pending.length ? <ol className="wd-pending" aria-label={writable ? 'Messages you are sending' : 'Pending messages kept'}>{composer.pending.map((pending) => (
        <li key={pending.id} id={`pending-${pending.id}`} data-client-message-id={pending.id} data-send-state={pending.state} className={`wd-pending__item is-pending${pending.state === 'failed' ? ' is-failed-send' : ''}`}>
          <PendingFiles body={pending.body ? <span className="wd-pending__body">{pending.body}</span> : null} files={pending.files} send={{ state: pending.state, ...(writable ? { onRetry: () => composer.retry(pending.id) } : {}) }} />
          <PendingSource item={pending} />
          {writable ? <OutboxStatus item={pending} onRetry={() => composer.retry(pending.id)} onRemove={() => composer.remove(pending.id)} />
            : <p className="wd-muted" role="status">{pending.state === 'failed' ? 'Unsent message kept.' : 'Send not confirmed. Your message is kept.'} You cannot send to this task.</p>}
        </li>
      ))}</ol> : null}
      <ol className="wd-act" aria-label="Task activity">
        {(state.loading ? [] : state.lines).map((line) => {
          if (line.kind === 'message') {
            const message = line.message;
            const name = state.author(message);
            const agent = message.authorId === null;
            const mine = message.authorId === me.id;
            return (
              <li key={line.key} className="wd-act__item wd-act__item--message" data-message-id={message.id}>
                <Face actor={{ kind: agent ? 'agent' : 'human', name }} mine={mine} />
                <div className="wd-act__body">
                  <p className="wd-act__who">
                    {agent ? <AgentIdentity name={name} owner={message.author.kind === 'agent' ? agentAuthorOwner(message.author, owners) : undefined} icon={false} /> : <b title={name}>{firstName(name)}</b>}
                    {message.via ? <span className="project-convo__via">via {message.via}</span> : null}
                    <time dateTime={message.createdAt} title={when(message.createdAt)}>{stamp(message.createdAt)}</time>
                    {message.editedAt ? <span className="message-edited" title={`Edited ${when(message.editedAt)}`}> · edited</span> : null}
                  </p>
                  <div className={`wd-act__bubble${hasPhotos(message.files) ? ' has-photos' : ''}`}>
                    <MessageContent files={message.files} context={{ author: name, at: message.createdAt, caption: message.body, place: project.name,
                      onReply: writable ? () => document.getElementById(composerId)?.focus() : undefined, onCreateTask: writable ? () => void makeWork.create(message) : undefined }}
                    body={message.body ? <div className={`message-body${message.removedAt ? ' message-body--removed' : ''}`}><MessageText body={message.body} linked={false} /></div> : null}>
                      <LinkPreviews body={message.body} projectId={project.id} messageId={message.id} />
                    </MessageContent>
                    {message.contribution ? <ContributionMark contribution={message.contribution} onOpenResult={(resultId) => openDetails({ kind: 'result', id: resultId, projectId: project.id }, { back: 'push' })} /> : null}
                  </div>
                  {agent && posted.get(message.id) ? <PostedLine change={posted.get(message.id)!} onChanged={() => { void posts.refresh(); state.reload(); }} /> : null}
                </div>
              </li>
            );
          }
          const actor = line.kind === 'change' ? line.entry.actor : line.actor;
          const mine = actor.id === me.id && actor.kind === 'human';
          const text = line.kind === 'change' ? changeText(line.entry) : line.kind === 'reverted' ? 'undid its creation' : line.source ? FROM[line.source] : 'created the task';
          return (
            <li key={line.key} className="wd-act__item" data-activity={line.kind === 'change' ? line.entry.kind : line.kind}>
              <Face actor={actor} mine={mine} />
              <p className="wd-act__line">
                {actor.kind === 'agent' ? <AgentIdentity name={actor.name} owner={owners.get(actor.id)} icon={false} /> : <b title={actor.name}>{firstName(actor.name)}</b>}
                {' '}{text}
                <time dateTime={line.at} title={when(line.at)}> · {stamp(line.at)}</time>
              </p>
            </li>
          );
        })}
      </ol>
      {state.hasEarlier ? <button type="button" className="wd-inline wd-act__earlier" disabled={state.busyEarlier} onClick={() => void state.loadEarlier()}>{state.busyEarlier ? 'Loading…' : 'Show earlier activity'}</button> : null}
    </section>
  );
}

/** The one composer, at the bottom of the panel: it writes to the task's discussion, which shows in the timeline above. */
export function TaskComposer({ state, composer, item, meId, writable, readOnly, id }: {
  state: TaskActivityState; composer: TaskComposerDraft; item: Pick<WorkItem, 'id' | 'number'>; meId: string; writable: boolean; readOnly: boolean; id: string;
}) {
  const touch = useMediaQuery(MEDIA.touch);
  const captureScope = useComposerScope(composer.key);
  const { discussion } = state;
  const hasRoot = !!discussion?.root;
  // Typing (#155 AC-2) is the task thread's: the same canonical conversation as the task's thread in Conversation
  // and in Agents, so a person writing in several of them is one person typing. A task without a first message has
  // no thread yet, so it has no scope (nothing is created to show it); neither does one whose creation was undone.
  const conversationId = readOnly ? null : discussion?.conversationId ?? null;
  const typing = useTyping(meId, conversationId ? { kind: 'conversation', id: conversationId } : null, writable);
  // The typing status is its own line under the box, so its whole sentence is readable at any width (#731).
  // It is always there, empty without a scope, so nothing changes place when a thread starts. The task's audience is the space's,
  // the default, so it is not said (#871).
  const typingLine = conversationId ? <TypingNotice {...typing} /> : <p className="typing-notice" aria-hidden="true">{'\u00a0'}</p>;
  const typingNotice = <div className="wd-foot__line">{typingLine}</div>;

  // `/ai …` asks the person's agent in this discussion; the words are not a message (#842).
  const asking = !state.aiOff && /^\/ai(\s|$)/.test(composer.draft.body);
  const [askFailure, setAskFailure] = useState('');
  async function askAgent() {
    const prompt = composer.draft.body.replace(/^\/ai\s*/, '').trim();
    const ready = askState(state.assistant.status);
    if (!conversationId) { setAskFailure('Start the discussion with a first message, then ask your agent with /ai.'); return; }
    if (!prompt) { setAskFailure('Say what to ask after /ai, for example /ai what is left on this task?'); return; }
    if (ready.kind !== 'ready') { setAskFailure(ready.note); return; }
    const active = captureScope();
    setAskFailure('');
    try { await state.assistant.ask(prompt); if (active()) composer.setBody(''); } catch (cause) { if (active()) setAskFailure(askError(cause)); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!writable || !discussion) return;
    if (asking) { await askAgent(); return; }
    typing.stop();
    // The message joins the task's queue and the field empties at once (#264); it shows in the timeline until stored.
    const outcome = composer.submit();
    if (!outcome) return;
    const active = captureScope();
    const result = await outcome;
    if (result.status === 'delivered' && active()) state.reload();
  }
  // A keyboard's Enter sends and Shift+Enter adds a line; a phone's Enter adds a line and its button sends (#189).
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsOnEnter(event, touch) || (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing)) { event.preventDefault(); void send(); }
  };
  if (!writable) {
    return <><p className="wd-muted wd-foot__note">{readOnly ? 'Creation was undone. This history is read-only; your unsent draft is kept.' : 'You can read this task but not write to it.'}</p>{typingNotice}</>;
  }
  return (
    <form className="wd-composer" onSubmit={(event) => void send(event)}>
      <ConnectionLine />
      <ComposerFiles state={composer} attach="none" />
      <ComposerBox id={id} label={hasRoot ? 'Write to this task' : 'First message about this task'} value={composer.draft.body} maxLength={20000}
        placeholder={`Write about #${item.number} · @ · /`} onChange={(value) => { setAskFailure(''); composer.setBody(value); typing.input(Boolean(value.trim()) && !/^\/ai(\s|$)/.test(value)); }} onBlur={typing.stop} onKeyDown={onKeyDown}
        attach={composer} sendLabel={hasRoot ? 'Send to task' : 'Start the discussion'} sendDisabled={!composer.canSend || !discussion} onSend={() => void send()} />
      {asking ? <div className="wd-foot__line"><ComposerAudience>Only you see the answer, until you choose Show everyone</ComposerAudience></div> : typingNotice}
      {askFailure ? <p className="wd-error" role="alert">{askFailure}</p> : null}
      <SendAnnouncer pending={composer.pending} />
    </form>
  );
}
