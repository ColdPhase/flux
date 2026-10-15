import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import type { Conversation, ConversationMessage, ConversationRoot, NativeWorkRow } from '@flux/contracts';
import type { MessageWorkPreview } from '../work/message-associations';
import { ApiError } from '../api/client';
import { MEDIA, useMediaQuery } from '../ui';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { excerpt } from '../live/anchors';
import { audienceLine, useProjectShell } from '../project/data';
import { useShellData } from './data';
import { agentAuthorLabel } from '../docs/format';
import { ConversationStream, useConversationRoots, useTaskNotices } from './ConversationStream';
import { ThreadDrawer, ThreadRoot, type ThreadMode } from './ThreadDrawer';
import type { ProjectData } from './ProjectConversation';
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
  rootHeader?: (objects: { preview: MessageWorkPreview | null; taskRow: NativeWorkRow | null }) => ReactNode;
  /** thread: the root's message id, which the stream shows and arrives at. */
  rootMessageId?: string | null;
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

interface NavState { fromStream?: boolean; backToStream?: boolean; focusComposer?: boolean }

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

  const onDenied = useCallback((cause: unknown) => {
    // A lost project or session reloads the route, which shows why instead of stale content.
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) revalidator.revalidate();
  }, [revalidator]);
  // A link names a root (or a reply in it): the stream reads back to it and shows it.
  const reveal = conversation && !state?.fromStream ? { conversationId: conversation.id, key: `${conversation.id}:${location.key}` } : null;
  const roots = useConversationRoots(project.id, data.roots, reveal?.conversationId ?? null, onDenied);
  const notices = useTaskNotices(project.id, data.notices, roots.roots, roots.hasOlder, onDenied);
  const root = thread ? roots.roots.find((item) => item.conversationId === thread.id) ?? null : null;
  const [endToken, setEndToken] = useState(0);

  const author = useCallback((message: ConversationMessage) => {
    if (message.authorId === null) return agentAuthorLabel(message.author);
    if (message.authorId === me.user.id) return me.user.name;
    return members.find((member) => member.userId === message.authorId)?.name
      ?? people?.find((person) => person.kind === 'human' && person.id === message.authorId)?.name ?? 'Member';
  }, [me.user.id, me.user.name, members, people]);

  // "Work on this together" starts at the open thread, or at the newest root as the project page did.
  const latest = roots.roots.at(-1) ?? null;
  const live = thread ? { id: thread.id, label: thread.firstMessageBody } : latest ? { id: latest.conversationId, label: latest.message.body } : null;
  useRegisterLiveHere(live ? { projectId: project.id, context: { type: 'conversation', id: live.id }, label: excerpt(live.label) } : null, null);

  // Docked beside the stream while both stay readable; otherwise a full sheet over it.
  const splitRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(MEDIA.navDrawer);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const split = splitRef.current;
    if (!split) return;
    const measure = () => setWide(split.clientWidth >= 760);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => observer.disconnect();
  }, []);
  const mode: ThreadMode = phone || !wide ? 'sheet' : 'docked';

  const opener = useRef<string | null>(null);
  const open = useCallback((item: ConversationRoot, reply: boolean) => {
    opener.current = item.message.id;
    if (thread && item.conversationId === thread.id) {
      document.getElementById(reply && writable ? 'thread-composer' : 'thread')?.focus();
      return;
    }
    // Switching threads replaces the open one, so closing still returns to the stream in one step.
    const backToStream = thread ? state?.backToStream === true : true;
    navigate(`/projects/${project.id}/conversations/${item.conversationId}`,
      { state: { fromStream: true, backToStream, focusComposer: reply } satisfies NavState, replace: !!thread && backToStream });
  }, [navigate, project.id, state?.backToStream, thread, writable]);
  const close = useCallback(() => {
    if (!thread) return;
    if (!opener.current) opener.current = root?.message.id ?? null;
    setClosing(thread.id);
    if (state?.backToStream) navigate(-1);
    else navigate(`/projects/${project.id}`, { state: { fromStream: true } satisfies NavState });
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
    <ConversationStream project={project} meId={me.user.id} meName={me.user.name} roots={roots} notices={notices} author={author}
      audience={audience} openId={thread?.id ?? null} reveal={reveal} arrived={arrived} endToken={endToken} onOpen={open} onDenied={onDenied} />
  );
  const rootMessage = root?.message ?? thread?.messages.find((message) => message.sequence === 1) ?? null;
  // Until the stream has the root (a link to an old one), the thread's newest sequence gives its size.
  const replies = root?.replyCount ?? Math.max(0, (thread?.messages.at(-1)?.sequence ?? 1) - 1);
  return (
    <div className={`convo-split${thread ? ` has-thread is-${mode}` : ''}`} ref={splitRef}>
      <div className="convo-split__stream" inert={!!thread && mode === 'sheet'}>
        <Pane key="stream" data={data} variant="stream" feed={stream}
          onPosted={(started) => { roots.posted(started); setEndToken((value) => value + 1); }} onSending={() => setEndToken((value) => value + 1)} newestRootAt={roots.roots.at(-1)?.message.createdAt ?? ''} />
      </div>
      {thread ? (
        <ThreadDrawer key={thread.id} mode={mode} count={replies} focusOnOpen={!!state?.fromStream && !state.focusComposer} onClose={close}>
          <Pane key={thread.id} data={data} variant="thread" rootMessageId={rootMessage?.id ?? null}
            focusComposer={!!state?.focusComposer} onThreadSize={roots.threadSize}
            rootHeader={({ preview, taskRow }) => <ThreadRoot message={rootMessage} projectId={project.id} body={rootMessage?.body ?? thread.firstMessageBody} author={rootMessage ? author(rootMessage) : null}
              agentOwner={rootMessage?.authorId === null ? agentAuthorOwner(rootMessage.author, owners) ?? null : null} meId={me.user.id} writable={writable} replies={replies} task={root?.task ?? null} taskRow={taskRow} preview={preview} onDenied={onDenied}
              photo={{ place: project.name, onReply: writable ? () => document.getElementById('thread-composer')?.focus() : undefined, onCreateTask: writable && rootMessage ? () => void makeWork.create(rootMessage) : undefined }} />} />
        </ThreadDrawer>
      ) : null}
    </div>
  );
}
