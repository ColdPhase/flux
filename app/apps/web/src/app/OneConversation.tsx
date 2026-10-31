import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import type { Conversation, ConversationMessage, ConversationRoot, NativeWorkRow, ObjectNotice } from '@flux/contracts';
import type { MessageWorkPreview } from '../work/message-associations';
import { ApiError } from '../api/client';
import { PanelMeta } from '../ui';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { excerpt } from '../live/anchors';
import { audienceLine, useProjectShell } from '../project/data';
import { useShellData } from './data';
import { agentAuthorLabel, FORMER_MEMBER } from '../docs/format';
import { ConversationStream, streamPlace, useConversationRoots, useObjectNotices, useTaskNotices } from './ConversationStream';
import { useStreamEvents } from '../api/stream';
import { ThreadRoot } from './ThreadRoot';
import { SourceOfContext } from './messageParts';
import { OwnedPanelContent, useOwnedPanel } from './ownedPanel';
import { useShellActions } from './shellContext';
import { recall, useArrival } from '../place/memory';
import { useOriginLabel, useOriginPanelBack } from '../place/origin';
import type { ProjectData } from '../conversations/loader';
import './one-conversation.css';
import { useCreateWorkFromMessage } from '../work/inline';

/** What the conversation pane needs in each place: the stream's composer, or one open thread. */
export interface PaneProps {
  data: ProjectData;
  variant: 'stream' | 'thread';
  /** stream: the stream of roots, in place of one conversation's feed. */
  feed?: ReactNode;
  /**
   * thread: the message the replies answer, at the top of the thread. The pane gives it what was made from
   * the root and the discussed task's row, from its own bounded reads (#155), never a project collection.
   */
  /** `firstDay`: the day of the first reply, which the root's reply count line names instead of a day line of its own. */
  rootHeader?: (objects: { preview: MessageWorkPreview | null; taskRow: NativeWorkRow | null; firstDay: string | null }) => ReactNode;
  /** thread: the root's message id, which the stream shows and arrives at. */
  rootMessageId?: string | null;
  /** thread: the decisions and results the project's conversation announces (#694); the thread shows the ones made from it. */
  objects?: ObjectNotice[];
  /** stream: a root the person just started. */
  onPosted?: (conversation: Conversation) => void;
  /** stream: the person sent a root; it shows at once at the end of the stream (#264). */
  onSending?: () => void;
  /** stream: when the newest root shown was written; a refreshed root newer than that may be the one being sent. */
  newestRootAt?: string;
  /** thread: its latest size, so the stream's reply count matches it. */
  onThreadSize?: (conversationId: string, replyCount: number, lastReplyAt: string | null) => void;
  /** thread: the person chose Reply, or a link asked to write a reply. */
  focusComposer?: boolean;
}

interface NavState { fromStream?: boolean; backToStream?: boolean; focusComposer?: boolean; keepPanel?: boolean; sourceOf?: string }

/**
 * One project conversation (UI116-1, 2026-10-02): the stream of roots with its composer, and the open
 * root's thread beside it. A conversation URL (`/projects/:id/conversations/:conversationId`, with an
 * optional `#message-…`) opens the stream at that root with its thread open; choosing a root's replies
 * here opens the same URL without moving the stream, and closing returns to the same place.
 */
export function OneConversation({ data, Pane }: { data: ProjectData; Pane: ComponentType<PaneProps> }) {
  const { project, conversation, members } = data;
  const { me } = useShellData();
  const shell = useProjectShell();
  const people = shell?.people ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const state = location.state as NavState | null;
  const arrived = location.hash.startsWith('#message-') ? location.hash.slice('#message-'.length) : null;
  // Closing hides the thread at once while the route settles; a later thread starts open.
  const [closing, setClosing] = useState<string | null>(null);
  const [shownId, setShownId] = useState(conversation?.id ?? null);
  if ((conversation?.id ?? null) !== shownId) { setShownId(conversation?.id ?? null); setClosing(null); }
  const thread = conversation && conversation.id !== closing ? conversation : null;
  const writable = project.access !== 'viewer';
  const makeWork = useCreateWorkFromMessage(project);
  const owners = useAgentOwners(project);
  const { reopenPanel } = useShellActions();

  const onDenied = useCallback((cause: unknown) => {
    // A lost project or session reloads the route, which shows why instead of stale content.
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) revalidator.revalidate();
  }, [revalidator]);
  // Coming back to this entry (Back, Forward, the way back from a reference): the stream returns to where it was left (#592).
  const arrival = useArrival();
  const [restore] = useState(() => arrival ? streamPlace(recall('stream', arrival)) : null);
  // A link names a root (or a reply in it): the stream reads back to it and shows it. A return to an entry keeps its own place instead.
  const reveal = conversation && !state?.fromStream && !restore ? { conversationId: conversation.id, key: `${conversation.id}:${location.key}` } : null;
  const roots = useConversationRoots(project.id, data.roots, reveal?.conversationId ?? restore?.conv ?? null, onDenied);
  const notices = useTaskNotices(project.id, data.notices, roots.roots, roots.hasOlder, onDenied);
  const objects = useObjectNotices(project.id, data.objectNotices, roots.roots, roots.hasOlder, onDenied);
  // Another member proposes or accepts a decision, records a result or makes a task (#694): the stream and an open thread
  // read it now instead of at the next poll. The events carry ids only; what is shown is read through the API.
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType === 'project' && event.objectId === project.id && /^project\.(decision_(proposed|accepted)|result_recorded|work_created|assistant_change_undone)\.v1$/.test(event.kind)) revalidator.revalidate();
  });
  const root = thread ? roots.roots.find((item) => item.conversationId === thread.id) ?? null : null;
  const [endToken, setEndToken] = useState(0);
  // The control on a page opened from here names this place: a task's thread is "#12 Order sensors" (#592).
  useOriginLabel(thread ? root?.task ? `#${root.task.number} ${root.task.title}` : 'Thread' : 'Conversation');

  const author = useCallback((message: ConversationMessage) => {
    if (message.authorId === null) return agentAuthorLabel(message.author);
    if (message.authorId === me.user.id) return me.user.name;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? FORMER_MEMBER;
  }, [me.user.id, me.user.name, members, people]);

  // "Work on this together" starts at the open thread, or at the newest root as the project page did.
  const latest = roots.roots.at(-1) ?? null;
  const live = thread ? { id: thread.id, label: thread.firstMessageBody } : latest ? { id: latest.conversationId, label: latest.message.body } : null;
  useRegisterLiveHere(live ? { projectId: project.id, context: { type: 'conversation', id: live.id }, label: excerpt(live.label) } : null, null);

  const opener = useRef<string | null>(null);
  const open = useCallback((item: ConversationRoot, reply: boolean) => {
    opener.current = item.message.id;
    if (thread && item.conversationId === thread.id) {
      // The thread is already this one: bring its panel back if something closed or covered it, then go to it.
      reopenPanel(`thread:${thread.id}`);
      document.getElementById(reply && writable ? 'thread-composer' : 'details')?.focus();
      return;
    }
    // Switching threads replaces the open one, so closing still returns to the stream in one step.
    const backToStream = thread ? state?.backToStream === true : true;
    navigate(`/projects/${project.id}/conversations/${item.conversationId}`,
      { state: { fromStream: true, backToStream, focusComposer: reply } satisfies NavState, replace: !!thread && backToStream });
  }, [navigate, project.id, reopenPanel, state?.backToStream, thread, writable]);
  const close = useCallback((options?: { keepPanel?: boolean }) => {
    if (!thread) return;
    if (!opener.current) opener.current = root?.message.id ?? null;
    setClosing(thread.id);
    if (state?.backToStream && !options?.keepPanel) navigate(-1);
    else navigate(`/projects/${project.id}`, { state: { fromStream: true, ...(options?.keepPanel ? { keepPanel: true } : {}) } satisfies NavState });
  }, [navigate, project.id, root?.message.id, state?.backToStream, thread]);
  // Closing gives focus back to the root's replies, where the person opened the thread.
  useEffect(() => {
    if (thread || !opener.current) return;
    const target = document.getElementById(`message-${opener.current}`);
    opener.current = null;
    (target?.querySelector<HTMLElement>('.convo-replies button') ?? target)?.focus({ preventScroll: true });
  }, [thread]);

  const audience = audienceLine(people, me.user.id, project.visibility === 'workspace');
  const stream = (
    <ConversationStream project={project} meId={me.user.id} meName={me.user.name} roots={roots} notices={notices} goals={data.goals} objects={objects} author={author}
      audience={audience} openId={thread?.id ?? null} reveal={reveal} arrived={arrived} endToken={endToken} restore={restore} onOpen={open} onDenied={onDenied} />
  );
  // Until the stream has the root (a link to an old one), the thread's newest sequence gives its size.
  const replies = root?.replyCount ?? Math.max(0, (thread?.messages.at(-1)?.sequence ?? 1) - 1);
  const rootMessage = root?.message ?? thread?.messages.find((message) => message.sequence === 1) ?? null;
  // A thread a reference led to, in a sheet or an overlay over the header, carries the way back to where it was followed from (#592).
  const originBack = useOriginPanelBack();
  const slot = useOwnedPanel(thread ? { key: `thread:${thread.id}`, chip: 'Thread', label: 'Replies', startFull: true, ...(originBack ? { origin: originBack } : {}), onClose: close } : null);
  // A link to a reply, or one that asks to keep the panel, shows the thread even when another object (What matters, a task) covers it.
  const toReply = !!arrived && arrived !== rootMessage?.id;
  useEffect(() => {
    if (thread && (toReply || state?.keepPanel)) reopenPanel(`thread:${thread.id}`);
    // Only a new arrival (a navigation) asks for it, never a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  // A link that asks to write (Discuss on a decision, #763 D3) focuses the field it lands on, also when that pane was already open.
  useEffect(() => {
    if (!state?.focusComposer) return;
    const frame = requestAnimationFrame(() => document.getElementById(thread ? 'thread-composer' : 'project-composer')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
    // Only a new arrival (a navigation) asks for it, never a re-render; the thread is the one the address names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, thread?.id]);
  // A link from a task's "Came from" names the task: the message it arrived at is tagged "Source of #1" for two seconds.
  const sourceOf = arrived && state?.sourceOf ? { messageId: arrived, label: `Source of ${state.sourceOf}` } : null;
  return (
    <SourceOfContext.Provider value={sourceOf}>
    <div className="convo-split">
      <div className="convo-split__stream">
        <Pane key="stream" data={data} variant="stream" feed={stream}
          onPosted={(started) => { roots.posted(started); setEndToken((value) => value + 1); }} onSending={() => setEndToken((value) => value + 1)} newestRootAt={roots.roots.at(-1)?.message.createdAt ?? ''} />
      </div>
      {thread && slot ? (
        <OwnedPanelContent slot={slot} className="thread" id="thread">
          <PanelMeta>{replies} {replies === 1 ? 'reply' : 'replies'}</PanelMeta>
          <Pane key={thread.id} data={data} variant="thread" rootMessageId={rootMessage?.id ?? null} objects={objects}
            focusComposer={!!state?.focusComposer} onThreadSize={roots.threadSize}
            rootHeader={({ preview, taskRow, firstDay }) => <ThreadRoot firstDay={firstDay} message={rootMessage} projectId={project.id} body={rootMessage?.body ?? thread.firstMessageBody} author={rootMessage ? author(rootMessage) : null}
              agentOwner={rootMessage?.authorId === null ? agentAuthorOwner(rootMessage.author, owners) ?? null : null} meId={me.user.id} writable={writable} replies={replies} task={root?.task ?? null} taskRow={taskRow} preview={preview} onDenied={onDenied}
              photo={{ place: project.name, onReply: writable ? () => document.getElementById('thread-composer')?.focus() : undefined, onCreateTask: writable && rootMessage ? () => void makeWork.create(rootMessage) : undefined }} />} />
        </OwnedPanelContent>) : null}
    </div>
    </SourceOfContext.Provider>
  );
}
