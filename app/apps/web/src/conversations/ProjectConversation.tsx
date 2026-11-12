import { useEffect } from 'react';
import type { ConversationMessage } from '@flux/contracts';
import { useLoaderData } from 'react-router';
import { outboxView } from '../composer/draft';
import { useFileDrop } from '../composer/Files';
import { Button, MEDIA, useMediaQuery } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { OneConversation, type PaneProps } from '../app/OneConversation';
import { threadObjects } from '../app/objectNotices';
import { useSpaceAi } from '../ai/spaceAi';
import { useProjectQuestions } from '../agents/questions';
import { useAgentOwners } from '../agents/owners';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { PrivateAiLines } from '../assistant/PrivateAiLines';
import { useFollowEnd } from '../assistant/useFollowEnd';
import { useAssistantChanges } from '../assistant/WaitingChanges';
import { agentAuthorLabel, FORMER_MEMBER } from '../docs/format';
import { useProjectMaterials } from '../materials/useProjectMaterials';
import { useTyping } from '../typing/useTyping';
import { useCreateWorkFromMessage } from '../work/inline';
import { MessageWorkPages } from '../work/MessageWorkPages';
import '../app/project-conversation.css';
import { feedEntries } from './feed';
import type { ProjectData } from './loader';
import { PaneComposer } from './PaneComposer';
import { usePaneAccess, usePaneCore } from './paneCore';
import { ThreadFeed } from './ThreadFeed';
import { useAskBar } from './useAskBar';
import { useAssistantAsk } from './useAssistantAsk';
import { useComposerDrafts } from './useComposerDrafts';
import { useComposerMenu } from './useComposerMenu';
import { useComposerSend } from './useComposerSend';
import { useThreadPlace } from './useThreadPlace';
import { useThreadReading } from './useThreadReading';
import { useThreadReplies } from './useThreadReplies';

export function ProjectConversation() {
  const data = useLoaderData() as ProjectData;
  const { me } = useShellData();
  // Agents' questions with ready answers (S14): one read of the project's questions for every card below.
  const aiOn = !useSpaceAi(data.project.id).blocked;
  useProjectQuestions(data.project.id, me.user.id, aiOn);
  return <div className="project-page">
    <OneConversation key={`${me.user.id}:${data.project.id}`} data={data} Pane={ProjectConversationContent} />
  </div>;
}

/**
 * One conversation's pane: in the stream it is the composer that starts a root (UI116-1); in the thread
 * beside it, the replies with their own composer, assistant and sources. The parts live in this folder:
 * the replies (`useThreadReplies`), how they are read (`useThreadReading`, `useThreadPlace`), the composer
 * (`useComposerDrafts`, `useComposerMenu`, `useComposerSend`), the assistant (`useAssistantAsk`, `useAskBar`)
 * and the views (`ThreadFeed`, `PaneComposer`).
 */
function ProjectConversationContent({ data, variant, feed, rootHeader, rootMessageId = null, objects = [], onPosted, onSending, newestRootAt, onThreadSize, focusComposer = false }: PaneProps) {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const core = usePaneCore(data, variant);
  const { me, project, conversation, writable, aiOff, composerId } = core;
  const { openDetails } = useShellActions();
  const { accessLost, hideIfDenied } = usePaneAccess(core);
  const drafts = useComposerDrafts(core);
  const { asking, publicComposer } = drafts;
  const materials = useProjectMaterials({ userId: me.user.id, project, inThread: !!conversation, writable, initial: data.materials, initialTotal: data.materialTotal,
    onDenied: hideIfDenied, onSaved: () => { void thread.refresh(); } });
  const thread = useThreadReplies(core, { sent: publicComposer.sent, hideIfDenied, mergeMaterials: materials.merge, onThreadSize });
  const { messages } = thread;
  // The signed-in person's own assistant (#68, #842): ask mode, their working line and their private answers, here or in the space's main conversation.
  const assistant = useConversationAssistant({ meId: me.user.id, place: core.place, enabled: !aiOff,
    onShown: () => { if (conversation) void thread.refresh(); else onSending?.(); } });
  // The person's own agent at work, and what it answered, are at the end of the stream or thread: a new one comes into view (#842).
  const privateItems = [...assistant.privateAnswers.map((item) => item.id), assistant.run?.id ?? ''].join(',');
  useFollowEnd(() => document.querySelector<HTMLElement>(conversation ? '.thread__feed' : '.project-convo__feed.is-stream'), privateItems.replaceAll(',', '') ? privateItems : '', assistant.run?.id ?? null);
  const outbox = outboxView(messages, conversation ? publicComposer.pending : [], publicComposer.sent, me.user.id);
  const reading = useThreadReading(core, { messages, pendingCount: outbox.pending.length, rootMessageId, accessLost, hideIfDenied });
  // Typing (#155) is the thread's: an ephemeral signal to the people who can read this conversation. The
  // stream's composer has no conversation yet, so it has no typing scope.
  const typing = useTyping(me.user.id, conversation && !accessLost ? { kind: 'conversation', id: conversation.id } : null, writable && !asking && !drafts.busy);
  const ask = useAssistantAsk(core, { drafts, assistant, scrollRef: reading.scrollRef, scrollToEnd: reading.scrollToEnd });
  const askBar = useAskBar(core, assistant, ask);
  const menu = useComposerMenu(core, { drafts, assistant, ask, typing, openSources: () => materials.setSourcesOpen(true) });
  const actions = useComposerSend(core, { drafts, menu, ask, thread, typing, touch, rootMessageId, newestRootAt, scrollToEnd: reading.scrollToEnd, hideIfDenied,
    closeSources: () => materials.setSourcesOpen(false), onPosted, onSending });
  const { arrived, seen, unreadFrom, newBelow } = useThreadPlace(core, { thread, reading, outbox, rootMessageId, hideIfDenied });
  // Files dropped anywhere on the conversation join its draft (#348).
  const drop = useFileDrop(publicComposer, writable && !asking);
  const makeWork = useCreateWorkFromMessage(project);
  const author = (id: string) => id === me.user.id ? me.user.name : data.members.find((member) => member.userId === id)?.name ?? FORMER_MEMBER;
  const messageAuthor = (item: ConversationMessage) => item.authorId !== null ? author(item.authorId) : agentAuthorLabel(item.author);
  const owners = useAgentOwners(project);
  // The owner's waiting changes (F-027 A3): refreshed when their run moves.
  const changes = useAssistantChanges(conversation?.id ?? null, `${assistant.run?.id ?? ''}:${assistant.run?.status ?? ''}:${assistant.tick}`, !aiOff);
  useFocusOnOpen(focusComposer, composerId);

  if (accessLost) return <div className="pane-scroll"><div className="pane-in project-setup" role="alert"><h2>Space unavailable</h2><p>Your access to this space may have changed. Reload to check current access.</p></div></div>;
  // The root sits at the thread's top (and in the stream); the list holds its replies.
  // What came of this thread (#694): the decisions made from it stand among its replies, in time order.
  const made = conversation ? threadObjects(conversation.id, new Set(messages.map((message) => message.id)), objects) : [];
  const entries = feedEntries(messages.filter((message) => message.sequence > 1), !!thread.olderCursor, made);
  const { messageWork, referenceWork } = reading;
  const others = (core.people ?? []).filter((person) => person.kind === 'human' && person.id !== me.user.id).map((person) => person.name.trim().split(/\s+/)[0] || person.name);
  const privateAi = { assistant, changes, others, lookups: { projectId: project.id, messages, work: referenceWork.rows, author, people: core.people } };
  return <div className={`${conversation ? 'thread__pane' : 'project-convo'}${drop.dropping ? ' is-dropping' : ''}`} {...drop.handlers} data-project-id={conversation ? undefined : project.id}
    data-associations-observed-at={conversation ? messageWork.page?.observedAt : undefined} data-associations-phase={conversation ? messageWork.state.phase : undefined}
    data-references-observed-at={conversation ? referenceWork.observation?.observedAt : undefined} data-references-phase={conversation ? referenceWork.state.phase : undefined}>
    {!conversation ? feed?.(<PrivateAiLines assistant={assistant} meId={me.user.id} meName={me.user.name} others={others} composerId={composerId} lookups={privateAi.lookups} own />) : <ThreadFeed core={core} thread={thread} reading={reading} entries={entries} outbox={outbox} publicComposer={publicComposer} privateAi={privateAi} owners={owners}
      people={core.people} makeWork={makeWork} arrived={arrived} seen={seen} messageAuthor={messageAuthor} openDetails={openDetails} hideIfDenied={hideIfDenied}
      waitingHere={ask.waitingHere} rootHeader={rootHeader} rootMessageId={rootMessageId} unreadFrom={unreadFrom} newBelow={newBelow} />}
    {conversation ? <MessageWorkPages read={messageWork} /> : null}
    {conversation && referenceWork.state.phase === 'unavailable' ? <div className="ws-message-pages" role="alert">Referenced tasks could not be checked. Your reply is kept. <Button variant="link" size="sm" onClick={referenceWork.refresh}>Refresh task references</Button></div> : null}
    <PaneComposer core={core} drafts={drafts} menu={menu} actions={actions} ask={ask} askBar={askBar} assistant={assistant} materials={materials} typing={typing}
      readFailure={thread.readFailure} author={author} />
  </div>;
}

/** When the thread opens for a reply, its field takes focus once. */
function useFocusOnOpen(focusComposer: boolean, composerId: string) {
  useEffect(() => {
    if (focusComposer) document.getElementById(composerId)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
