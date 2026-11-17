import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { AssistantChange, ConversationMessage, LiveCallLine, NamedPrincipal, ObjectLink, Project, TaskActivityEntry, TaskDiscussion as Discussion, WorkItem, WorkspaceMember } from '@flux/contracts';
import { AgentIdentity, Avatar, Button, Kreska, MEDIA, sendsOnEnter, useMediaQuery, type AgentHue } from '../ui';
import { useComposerScope, type useComposerDraft } from '../composer/draft';
import { ComposerFiles, MessageContent, hasPhotos } from '../composer/Files';
import { ComposerAudience, ComposerBox } from '../composer/ComposerBox';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { ConnectionLine, OutboxStatus, PendingFiles, SendAnnouncer } from '../composer/Outbox';
import { ContributionMark, clock, day, shownAnswer, shownLabel, when } from '../app/messageParts';
import { useShellData } from '../app/data';
import { useProjectShell } from '../project/data';
import { getTaskDiscussion } from '../composer/api';
import { agentDisplayName, named, personName, youLabel } from '../docs/format';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { useAgentHue } from '../agents/hues';
import { TaskAgentState, type AgentDone } from '../agents/TaskAgentState';
import { ClientChanges } from '../assistant/ClientChanges';
import { failure, useAssistantChanges } from '../assistant/WaitingChanges';
import { askError, askState, canHaveAi, connectsFirst } from '../assistant/format';
import { useShellActions } from '../app/shellContext';
import { assistantSuggestions, noteAssistantUse } from '../assistant/MeetAssistant';
import { useAskMenu } from '../assistant/useAskMenu';
import { ComposerMenu } from '../app/ComposerMenu';
import { PrivateAiLines, firstNames } from '../assistant/PrivateAiLines';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useSpaceAi } from '../ai/spaceAi';
import { undoChange } from '../assistant/api';
import { RefLink } from '../place/origin';
import { useCreateWorkFromMessage } from './inline';
import { ShowEarlier } from './DecisionDiscussion';
import { getTaskActivity } from './api';
import { STATUS_LABEL } from './format';
import { dueLabel } from './TaskParts';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import { callNameOf, callWords, useCallLines, useNow } from '../live/callLines';
import { useStreamEvents } from '../api/stream';
import { END_SLACK, NewBelow, arrivedBelow, useNewBelow } from '../app/unreadReading';
import { useObservation } from '../app/receipts';
import { observeProjectMessages } from '../conversations/api';
import { opensAtTop } from './panelOpening';

// A task's one discussion (F-026 P10, #488, #1364): one timeline, oldest first with the newest at the bottom above the composer (every
// discussion lists oldest first: founder decision, Hubert, 2026-11-15, round 8, #1424), of what changed and who said what. It has no heading
// of its own, "Activity" being removed by the design (§8); the region is named "Discussion" for a screen reader. Each line has its
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
/**
 * What another person wrote, edited or deleted in a space (persona round 10): the open panel reads its discussion again, as an open thread does.
 * The stream carries identifiers only, so no words are read from the event.
 */
const DISCUSSION_EVENT = /^project\.(conversation_created|message_sent|message_edited|message_removed)\.v1$/;
/** How far back a page of the discussion reaches: the sequence it continues before, 0 once nothing is left before it. */
const reach = (page: Discussion['messagePage']) => (page.hasMoreBefore ? page.nextBeforeSequence ?? Number.MAX_SAFE_INTEGER : 0);

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
  message: 'created it from a message', thought: 'created it from a thought on the map', plan: 'created it from a plan revision', material: 'created it from a source', doc: 'created it from a Wiki page',
};

/** The text after the actor's name; the actor and the time are shown beside it. */
function changeText(entry: TaskActivityEntry, meId: string): string {
  const rule = entry.automation === 'github_rule' ? ' (a pull request rule)' : entry.automation === 'agent_rule' ? ' (its agent finished)'
    : entry.automation === 'agent_unable' ? ' (its agent couldn’t take it)'
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
    // A person stopped the agent (v0.2.1 release gate, M21): a stop, not a take or a finish, in the words of the task's state line.
    if (entry.automation === 'agent_stopped') return `stopped ${from?.name ?? 'the agent'}; the task is back with ${named(to, meId)}`;
    // A person who made themselves the owner took it: "Ana took it", never "Ana assigned it to Ana Souza" (personas-26).
    if (to.kind === entry.actor.kind && to.id === entry.actor.id) return `took it${from ? ` from ${from.name}` : ''}${rule}`;
    return `${to.kind === 'agent' ? 'handed it off to' : from ? 'reassigned it to' : 'assigned it to'} ${to.name}${rule}`;
  }
  if (entry.kind === 'due' && entry.due) {
    return entry.due.to ? `set it due ${dueLabel(entry.due.to)}${rule}` : `cleared the due date${rule}`;
  }
  if (entry.kind === 'title' && entry.title) return `renamed it to “${entry.title.to}”${rule}`;
  return `changed it${rule}`;
}

// A time is Geist with tabular figures (README §2 Typography), never a monospace: Geist Mono gives the colon a cell of its own ("17 : 48").
function stamp(at: string) { return <>{day(at)}, {clock(at)}</>; }

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
        // A read again (a new message, a change) brings the newest page; the earlier pages already shown stay, with how far back they reach.
        setDiscussion((current) => current && current.workId === talk.value.workId && reach(current.messagePage) < reach(talk.value.messagePage)
          ? { ...talk.value, messagePage: current.messagePage } : talk.value);
        setMessages((current) => mergeMessages(current, [...(talk.value.root ? [talk.value.root] : []), ...talk.value.messages]));
      }
      setFailed(activity.status === 'rejected' && talk.status === 'rejected' ? 'all' : activity.status === 'rejected' ? 'changes' : null);
      setReads((value) => value + 1);
    });
    return () => controller.abort();
  }, [item.id, project.id, me.id, attempt, revision]);
  // The discussion is live (persona round 10, S23): a message by anyone shows while the panel is open, without a reload.
  useStreamEvents(me.id, (event) => {
    if (event.objectType === 'project' && event.objectId === project.id && DISCUSSION_EVENT.test(event.kind)) setAttempt((value) => value + 1);
  }, () => setAttempt((value) => value + 1));

  // The root is always read with the newest page, so the oldest reply shown is where the earlier page begins: every message in between is
  // one "Show earlier" away, oldest first (founder decision, round 8, #1424; personas-33 P2 3).
  const oldest = messages.find((message) => message.sequence > 1);
  const olderMessages = !!discussion?.messagePage.hasMoreBefore && !!oldest && oldest.sequence > 2;
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
    return personName(message.authorId, { id: me.id, name: me.name }, members, people, message.removedAuthorName);
  }, [me.id, me.name, members, people]);

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const entry of changes ?? []) out.push({ kind: 'change', key: `change-${entry.id}`, at: entry.at, entry });
    for (const message of messages) {
      // The reason a task was blocked with is also contributed to its discussion. The change line already says it only when it was
      // saved with the status, in one request; a reason saved after the status (the unified panel's Edit) is on no line but this message.
      const said = message.contribution?.kind === 'blocker' && (changes ?? []).some((entry) => entry.kind === 'status' && entry.status?.to === 'blocked'
        && entry.status.blocker === message.body && Math.abs(Date.parse(entry.at) - Date.parse(message.createdAt)) < 15_000);
      if (!said) out.push({ kind: 'message', key: `message-${message.id}`, at: message.createdAt, message });
    }
    if (item.lifecycle?.state === 'creation_reverted') out.push({ kind: 'reverted', key: 'reverted', at: item.lifecycle.revertedAt, actor: item.lifecycle.revertedBy });
    // The task's creation is the oldest line, shown once nothing older is left to load.
    if (!hasEarlier) out.push({ kind: 'created', key: 'created', at: item.createdAt, actor: item.createdBy, source: sourceOf(item, links) });
    // The timeline is whole from "Show earlier" down, as the decision's is (personas-35): while the messages or the changes have more to read, no
    // line older than the oldest one loaded of that list is shown, so the first message (read with every page) never stands alone above the newest
    // page with the ones between it missing. "Show earlier" brings them in, in order.
    const messagesFrom = olderMessages && oldest ? Date.parse(oldest.createdAt) : Number.NEGATIVE_INFINITY;
    const changesFrom = nextBefore && changes?.length ? Math.min(...changes.map((entry) => Date.parse(entry.at))) : Number.NEGATIVE_INFINITY;
    const from = Math.max(messagesFrom, changesFrom);
    // Oldest first (round 8, #1424); the task's creation leads whatever shares its instant.
    return out.filter((line) => Date.parse(line.at) >= from)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === 'created' ? -1 : b.kind === 'created' ? 1 : 0));
  }, [changes, messages, item, links, hasEarlier, olderMessages, oldest, nextBefore]);

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

function Face({ actor, mine, hue }: { actor: { kind: 'agent' | 'human'; id?: string | null; name: string }; mine: boolean; hue?: AgentHue | undefined }) {
  return actor.kind === 'agent' ? <Kreska size={20} className="wd-act__face" {...(hue ? { hue } : {})} /> : <Avatar name={actor.name} id={actor.id} size="sm" tone={mine ? 'me' : 'neutral'} />;
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

/** The timeline: oldest first with the newest at the bottom, each line with its author and time. */
export function ActivityTimeline({ state, composer, item, project, me, writable, composerId }: {
  state: TaskActivityState; composer: TaskComposerDraft; item: Pick<WorkItem, 'id' | 'version' | 'number' | 'title'>; project: Project; me: { id: string; name: string }; writable: boolean; composerId: string;
}) {
  const owners = useAgentOwners(project);
  const hueOf = useAgentHue();
  // A local client's change is said once, by its change line with Undo above; the timeline does not name the same change again, as "Claude
  // Code [Agent] for Ada" under another name (#1116). The two are made in one request, so they are told apart by their time.
  const [clientChanges, setClientChanges] = useState<AssistantChange[]>([]);
  const makeWork = useCreateWorkFromMessage(project);
  const headingId = useId();
  const { discussion } = state;
  // The newest stays in view at the bottom, above the field, as a line arrives or is sent (round 8, #1424). The panel opens as a decision's
  // does (personas-34, F-026 §7 "Tasks and the task panel"): once its discussion is read, its newest line is brought into view above the
  // field, as at the end of any conversation (S23); a short discussion moves nothing. What another person wrote while this reader reads
  // above the end does not move them: it is counted in "↓ N new" over the panel's foot (S23, persona round 10), as in every conversation.
  const section = useRef<HTMLElement>(null);
  const timeline = useRef<HTMLOListElement>(null);
  const [feed, setFeed] = useState<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { scroller.current = section.current?.closest<HTMLElement>('.wd__scroll') ?? null; setFeed(scroller.current); }, []);
  // Reading here is reading the discussion (personas-36): what another person wrote, seen in the panel, moves this reader's place in it as
  // the thread does, so the same discussion opened as a thread (from Search, a notice) shows "New" only above what was not seen here.
  const others = useMemo(() => state.lines.flatMap((line) => line.kind === 'message' && line.message.authorId !== me.id ? [line.message.id] : []), [state.lines, me.id]);
  useObservation({ scope: project.id, observe: (ids) => observeProjectMessages(project.id, ids), enabled: !state.loading && others.length > 0, feed: scroller, ids: others, depend: state.lines.length });
  const lineKeys = useMemo(() => state.lines.map((line) => line.key), [state.lines]);
  const below = useNewBelow(feed, undefined, lineKeys);
  const newest = `${state.lines.at(-1)?.key ?? ''}:${composer.pending.length}`;
  const shownNewest = useRef<string | null>(null);
  const shownLines = useRef<Set<string> | null>(null);
  const shownPending = useRef(0);
  useLayoutEffect(() => {
    if (state.loading) return;
    const seen = shownLines.current;
    shownLines.current = new Set(lineKeys);
    const sent = composer.pending.length > shownPending.current;
    shownPending.current = composer.pending.length;
    const before = shownNewest.current;
    shownNewest.current = newest;
    const root = section.current;
    if (before === null || seen === null) {
      // The first draw of the read discussion: the panel opens at its newest line, as the decision's panel does. A short discussion (one
      // that fits in the panel's height) moves nothing: its rows stay at the top, where the skeleton drew them (F-026 §7 "Both panels open
      // the same way"; #863 rule 6, no jump from the skeleton). Only the panel's own scroller moves, never the sheet or the page around it.
      // The phone's sheet and a short panel (200 % text) open at their top instead (`opensAtTop`): their few lines would show the newest and
      // nothing of the task.
      const scroller = root?.closest<HTMLElement>('.wd__scroll');
      const list = root?.querySelector<HTMLElement>('.wd-act');
      const last = list?.lastElementChild;
      if (scroller && !opensAtTop(scroller) && list && last instanceof HTMLElement && list.getBoundingClientRect().height > scroller.clientHeight) {
        // Its bottom padding too, so the newest line is whole at the end and no fade lies on it (round 14 look-b B1: 20 px short of the end).
        const over = last.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(scroller).paddingBottom) || 0);
        if (over > 0) scroller.scrollTop += over;
      }
      return;
    }
    if (before === newest) return;
    const lineOf = (key: string) => root?.querySelector<HTMLElement>(`[data-line="${CSS.escape(key)}"]`) ?? null;
    const added = state.lines.filter((line) => !seen.has(line.key));
    const others = added.filter((line) => !lineIsMine(line, me.id)).map((line) => line.key);
    // Where the reader was before these lines came: at the end, or above it.
    const grew = added.reduce((sum, line) => sum + (lineOf(line.key)?.getBoundingClientRect().height ?? 0), 0);
    const wasAtEnd = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight - grew < END_SLACK;
    if (!sent && others.length && !wasAtEnd) { below.add(arrivedBelow(feed, others, lineOf)); return; }
    // A line of the person's own that is not a message they sent (they set the status to Done, changed the owner) does not move the panel:
    // they stay at the control they used, with the title and the status in view (visual review 2026-11-17, core 33: Done jumped the sheet).
    if (!sent && !others.length) return;
    const last = root?.querySelector<HTMLElement>('.wd-pending__item:last-child') ?? root?.querySelector<HTMLElement>('.wd-act')?.lastElementChild;
    if (last instanceof HTMLElement) last.scrollIntoView({ block: 'nearest' });
  }, [newest, state.loading]);
  const people = useProjectShell()?.people ?? null;
  const othersOf = firstNames((people ?? []).filter((person) => person.kind === 'human' && person.id !== me.id).map((person) => person.name));
  // The calls started from this task (F-041 point 6), with the names of who was in them.
  const calls = useCallLines(project.id, item.id);
  const callName = (userId: string) => userId === me.id ? me.name : people?.find((person) => person.id === userId)?.name ?? 'Someone';
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
  // An agent's task that is done is said once, by its history line, the same for every reader; the agent's owner has Undo on it (personas-26).
  const [agentDone, setAgentDone] = useState<AgentDone | null>(null);
  const doneLine = useMemo(() => {
    if (!agentDone) return null;
    const done = state.lines.filter((line): line is Extract<typeof line, { kind: 'change' }> => line.kind === 'change' && line.entry.kind === 'status' && line.entry.status?.to === 'done');
    return (done.find((line) => line.entry.actor.kind === 'agent' && line.entry.actor.id === agentDone.agentId) ?? done[0])?.key ?? null;
  }, [agentDone, state.lines]);
  return (<>
    <section className="details__sec wd-activity" aria-labelledby={headingId} ref={section}>
      <div className="wd-sechead">
        <h4 id={headingId} className="ui-vh">Discussion</h4>
        {thread ? <RefLink className="wd-inline wd-activity__open" to={thread} state={{ keepPanel: true }}>Open in Conversation</RefLink> : null}
      </div>
      {state.failed === 'all' ? <p className="wd-error" role="alert">The discussion could not be loaded. <button type="button" className="wd-inline" onClick={state.retry}>Retry</button></p>
        : state.loading ? <p className="wd-muted" aria-busy="true">Loading…</p> : null}
      <TaskAgentState item={item} projectId={project.id} conversationId={discussion?.conversationId ?? null} revision={state.lines.length} onChanged={state.reload} elsewhere={inThread} onDone={setAgentDone} />
      {/* What a local client changed on this task, with its change line and Undo, as the assistant's changes have (#868, LC-2). */}
      <ClientChanges key={item.id} projectId={project.id} kind="work" id={item.id} refreshKey={state.lines.length} onChanges={setClientChanges} />
      {/* The person's own agent at work and what it answered them: theirs alone (#842). */}
      <PrivateAiLines own assistant={state.assistant} meId={me.id} meName={me.name} others={othersOf} composerId={composerId}
        lookups={{ projectId: project.id, messages: [], work: new Map(), author: () => '', people }} />
      {state.failed === 'changes' ? <p className="wd-error" role="alert">Some of the history could not be loaded. <button type="button" className="wd-inline" onClick={state.retry}>Retry</button></p> : null}
      <ShowEarlier shown={state.hasEarlier} busy={state.busyEarlier} load={state.loadEarlier} list={timeline} />
      <ol className="wd-act" aria-label="Task activity" ref={timeline}>
        {/* A call started from this task is one line of its discussion, in time order like the rest (F-041 point 6). */}
        {byTime((state.loading ? [] : state.lines.filter((line) => !(line.kind === 'change' && line.entry.actor.kind === 'agent'
          && clientChanges.some((change) => change.via !== null && Math.abs(Date.parse(change.createdAt) - Date.parse(line.at)) < 15_000)))).map((line) => ({ at: line.at, node: (() => {
          if (line.kind === 'message') {
            const message = line.message;
            const name = state.author(message);
            const agent = message.authorId === null;
            // An agent's answer its asker posted reads as that agent's message, for the asker too (#1232).
            const shown = shownAnswer(message);
            const mine = message.authorId === me.id && !shown;
            // A shown answer carries its agent's colour, and an agent's own message its author's (#1528): the same for every reader.
            const faceHue = shown?.colour ?? (message.author?.kind === 'agent' ? hueOf(message.author) : undefined);
            return (
              <li key={line.key} className="wd-act__item wd-act__item--message" data-line={line.key} data-message-id={message.id} {...(message.authorId !== me.id ? { 'data-observe-id': message.id } : {})} {...(shown ? { 'data-shown-answer': '', 'aria-label': shownLabel(shown, name).spoken } : {})}>
                <Face actor={{ kind: agent || shown ? 'agent' : 'human', id: message.authorId, name }} mine={mine} {...(faceHue ? { hue: faceHue } : {})} />
                <div className="wd-act__body">
                  <p className="wd-act__who">
                    {shown ? <><AgentIdentity name={shownLabel(shown, name).label} icon={false} hue={shown.colour} /><span className="ui-vh">, shown by {name}</span></>
                      : agent ? <AgentIdentity name={name} owner={message.author.kind === 'agent' ? agentAuthorOwner(message.author, owners) : undefined} icon={false} hue={faceHue} /> : <b>{youLabel(name, mine)}</b>}
                    {message.via && !shown ? <span className="project-convo__via">via {message.via}</span> : null}
                    <time dateTime={message.createdAt} title={when(message.createdAt)}>{stamp(message.createdAt)}</time>
                    {message.editedAt ? <span className="message-edited" title={`Edited ${when(message.editedAt)}`}> · edited</span> : null}
                  </p>
                  <div className={`wd-act__bubble${hasPhotos(message.files) ? ' has-photos' : ''}`}>
                    <MessageContent files={message.files} context={{ author: name, at: message.createdAt, caption: message.body, place: project.name,
                      onReply: writable ? () => document.getElementById(composerId)?.focus() : undefined, onCreateTask: writable ? () => void makeWork.create(message) : undefined }}
                    body={message.body ? <div className={`message-body${message.removedAt ? ' message-body--removed' : ''}`}><MessageText body={message.body} /></div> : null}>
                      <LinkPreviews body={message.body} projectId={project.id} messageId={message.id} />
                    </MessageContent>
                    {message.contribution ? <ContributionMark contribution={message.contribution} /> : null}
                  </div>
                  {agent && posted.get(message.id) ? <PostedLine change={posted.get(message.id)!} onChanged={() => { void posts.refresh(); state.reload(); }} /> : null}
                </div>
              </li>
            );
          }
          const actor = line.kind === 'change' ? line.entry.actor : line.actor;
          const mine = actor.id === me.id && actor.kind === 'human';
          const text = line.kind === 'change' ? changeText(line.entry, me.id) : line.kind === 'reverted' ? 'undid its creation' : line.source ? FROM[line.source] : 'created the task';
          return (
            <li key={line.key} className="wd-act__item" data-line={line.key} data-activity={line.kind === 'change' ? line.entry.kind : line.kind}>
              <Face actor={actor} mine={mine} hue={hueOf(actor.kind === 'agent' ? actor : null)} />
              <p className="wd-act__line">
                {actor.kind === 'agent' ? <AgentIdentity name={actor.name} owner={agentAuthorOwner(actor, owners)} icon={false} hue={hueOf(actor)} /> : <b>{youLabel(actor.name, mine)}</b>}
                {' '}{text}
                <time dateTime={line.at} title={when(line.at)}> · {stamp(line.at)}</time>
                {line.key === doneLine && agentDone?.undo ? <>{' '}<Button variant="quiet" size="sm" className="wd-act__undo" busy={agentDone.busy} onClick={agentDone.undo}>Undo</Button></> : null}
              </p>
            </li>
          );
        })() })), state.loading ? [] : calls.map((call) => ({ at: call.startedAt,
          node: <TaskCallLine key={call.id} line={call} nameOf={callName} mine={call.startedBy === me.id} /> })))}
      </ol>
      {composer.pending.length ? <ol className="wd-pending" aria-label={writable ? 'Messages you are sending' : 'Pending messages kept'}>{composer.pending.map((pending) => (
        <li key={pending.id} id={`pending-${pending.id}`} data-client-message-id={pending.id} data-send-state={pending.state} className={`wd-pending__item is-pending${pending.state === 'failed' ? ' is-failed-send' : ''}`}>
          <PendingFiles body={pending.body ? <div className="wd-pending__body"><MessageText body={pending.body} linked={false} /></div> : null} files={pending.files} send={{ state: pending.state, ...(writable ? { onRetry: () => composer.retry(pending.id) } : {}) }} />
          {writable ? <OutboxStatus item={pending} onRetry={() => composer.retry(pending.id)} onRemove={() => composer.remove(pending.id)} />
            : <p className="wd-muted" role="status">{pending.state === 'failed' ? 'Unsent message kept.' : 'Send not confirmed. Your message is kept.'} You cannot send to this task.</p>}
        </li>
      ))}</ol> : null}
    </section>
    {/* The "↓ N new" line, held over the foot of the panel's scroll while the reader is above the end (S23). */}
    <div className="wd-newbelow"><NewBelow count={below.count} onClick={below.toEnd} /></div>
  </>);
}

/** A line this reader wrote or made: their own arrival is never counted as new. */
function lineIsMine(line: Line, meId: string) {
  if (line.kind === 'message') return line.message.authorId === meId && !shownAnswer(line.message);
  const actor = line.kind === 'change' ? line.entry.actor : line.actor;
  return actor.kind === 'human' && actor.id === meId;
}

/** The one composer, at the bottom of the panel: it writes to the task's discussion, which shows in the timeline above. */
export function TaskComposer({ state, composer, meId, writable, readOnly, id }: {
  state: TaskActivityState; composer: TaskComposerDraft; meId: string; writable: boolean; readOnly: boolean; id: string;
}) {
  const touch = useMediaQuery(MEDIA.touch);
  const { openConnectAi } = useShellActions();
  const captureScope = useComposerScope(composer.key);
  const { discussion } = state;
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
  // `/` in the box lists `/ai` and, under it, this task's suggestions (#1224), once the task has a discussion to ask in.
  // `/ai` is offered when it can do something (#1424): not on a server that runs no AI; chosen without an assistant, it opens Connect AI.
  const menu = useAskMenu({ fieldId: id, draft: composer.draft.body, enabled: writable && !state.aiOff && !!conversationId && canHaveAi(state.assistant.status),
    suggestions: assistantSuggestions('task', meId, state.assistant.status?.state === 'ready'),
    onDraft: (value) => composer.setBody(value), onAsk: (text) => void askAgent(text),
    onCommand: (command) => { if (command === 'ai' && connectsFirst(askState(state.assistant.status))) openConnectAi(); } });
  async function askAgent(words?: string) {
    const prompt = words ?? composer.draft.body.replace(/^\/ai\s*/, '').trim();
    const ready = askState(state.assistant.status);
    if (!conversationId) { setAskFailure('Start the discussion with a first message, then ask your agent with /ai.'); return; }
    if (!prompt) { setAskFailure('Say what to ask after /ai, for example /ai what is left on this task?'); return; }
    if (ready.kind !== 'ready') { setAskFailure(ready.note); if (ready.action === 'connect') openConnectAi(); return; }
    const active = captureScope();
    setAskFailure('');
    try { noteAssistantUse(meId); await state.assistant.ask(prompt); if (active() && words === undefined) composer.setBody(''); } catch (cause) { if (active()) setAskFailure(askError(cause)); }
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
    if (menu.onKeyDown(event)) return;
    if (sendsOnEnter(event, touch) || (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing)) { event.preventDefault(); void send(); }
  };
  if (!writable) {
    // An undone task says so once, above (audit 3274a05: "Creation undone" three times); here only an unsent draft is mentioned, and only
    // when there is one (personas-28).
    const drafted = !!composer.draft.body.trim() || composer.draft.files.length > 0;
    if (readOnly) return <>{drafted ? <p className="wd-muted wd-foot__note">Your unsent draft is kept on this device.</p> : null}{typingNotice}</>;
    return <><p className="wd-muted wd-foot__note">You can read this task but not write to it.</p>{typingNotice}</>;
  }
  return (
    <form className="wd-composer" onSubmit={(event) => void send(event)}>
      <ConnectionLine />
      <ComposerFiles state={composer} attach="none" />
      <ComposerBox id={id} label="Write to this task" value={composer.draft.body} maxLength={20000}
        placeholder={['Write about this task…', 'Write']} onChange={(value, position) => { menu.change(position); setAskFailure(''); composer.setBody(value); typing.input(Boolean(value.trim()) && !/^\/ai(\s|$)/.test(value)); }} onSelect={menu.setCaret} onBlur={typing.stop} onKeyDown={onKeyDown}
        fieldProps={{ 'aria-controls': menu.open ? `${id}-menu` : undefined, 'aria-activedescendant': menu.open ? `${id}-menu-${menu.options[menu.active]!.id}` : undefined }}
        attach={composer} sendLabel="Send to task" sendDisabled={!composer.canSend || !discussion} onSend={() => void send()}
        menu={<ComposerMenu open={menu.open} id={`${id}-menu`} options={menu.options} active={menu.active} trigger="/" onPick={menu.pick} onHover={menu.setIndex} />} />
      {asking ? <div className="wd-foot__line"><ComposerAudience>Only you see the answer, until you choose Show everyone</ComposerAudience></div> : typingNotice}
      {askFailure ? <p className="wd-error" role="alert">{askFailure}</p> : null}
      <SendAnnouncer pending={composer.pending} />
    </form>
  );
}

/** Activity lines and call lines in one timeline, oldest first like the activity itself; at the same instant the activity line comes first. */
function byTime(lines: { at: string; node: ReactNode }[], calls: { at: string; node: ReactNode }[]): ReactNode[] {
  return [...lines.map((entry, index) => ({ ...entry, order: index })), ...calls.map((entry, index) => ({ ...entry, order: lines.length + index }))]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order).map((entry) => entry.node);
}

/**
 * A call started from the task, as one line of its activity (F-041): "Hubert started a call · 2 people · 4 min". Its Join is the task's own
 * button above (one way in per place), so the line has none.
 */
function TaskCallLine({ line, nameOf, mine }: { line: LiveCallLine; nameOf: (userId: string) => string; mine: boolean }) {
  const now = useNow(line.endedAt === null);
  const words = callWords(line, nameOf, now);
  const starter = callNameOf(line, nameOf)(line.startedBy);
  return (
    <li className="wd-act__item" data-activity="call" id={`call-${line.id}`}>
      <Face actor={{ kind: 'human', id: line.startedBy, name: starter }} mine={mine} />
      <p className="wd-act__line">
        {words.named ? <><b>{youLabel(starter, mine)}</b>{' '}</> : null}{words.text}
        <time dateTime={line.startedAt} title={when(line.startedAt)}> · {stamp(line.startedAt)}</time>
      </p>
    </li>
  );
}
