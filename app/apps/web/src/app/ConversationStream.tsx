import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Conversation, ConversationMessage, ConversationRoot, ConversationRootWindow, NamedPrincipal, Page, Project, TaskCreationNotice } from '@flux/contracts';
import { Avatar, Button, EmptyState, Icon } from '../ui';
import { MessageActions, MessageObjects, useCreateWorkFromMessage } from '../work/inline';
import type { ProjectWork } from '../work/api';
import { useShellActions } from './shellContext';
import { listConversationRoots, listTaskNotices } from './conversation-api';
import { ContributionMark, SourceCitation, clock, day, openOnWholeMessages, when } from './messageParts';

// One project conversation (UI116-1, 2026-10-02): a chronological stream of roots. Each root is the
// opening message of a stored conversation; its replies open beside it in a one-level thread.

const PAGE = 100;
/** At most this many pages (10,000 roots) are read to reach one root or close a gap. */
const MAX_PAGES = 100;

function mergeRoots(current: ConversationRoot[], incoming: ConversationRoot[]) {
  const byId = new Map(current.map((root) => [root.conversationId, root]));
  for (const root of incoming) byId.set(root.conversationId, root);
  return [...byId.values()].sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.conversationId.localeCompare(b.conversationId));
}

function mergeNotices(current: TaskCreationNotice[], incoming: TaskCreationNotice[]) {
  const byId = new Map(current.map((notice) => [notice.id, notice]));
  for (const notice of incoming) byId.set(notice.id, notice);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * One entry of the stream, in time order: a root, or one compact task-created announcement (UI116-3)
 * linking its task. An announcement is never a root and has no thread; the task's first genuine
 * contribution is the root its discussion grows under.
 */
export type StreamEntry =
  | { kind: 'root'; key: string; at: string; root: ConversationRoot }
  | { kind: 'notice'; key: string; at: string; notice: TaskCreationNotice };

/**
 * Roots and announcements by time; at the same instant the announcement comes first. While earlier
 * roots are still unloaded, announcements older than the first loaded root wait with them, so the
 * stream never shows an announcement out of its place.
 */
export function streamEntries(roots: ConversationRoot[], notices: TaskCreationNotice[] = [], hasOlder = false): StreamEntry[] {
  const from = hasOlder ? roots[0]?.message.createdAt ?? null : null;
  const entries: StreamEntry[] = [
    ...roots.map((root) => ({ kind: 'root' as const, key: root.conversationId, at: root.message.createdAt, root })),
    ...notices.filter((notice) => from === null || notice.createdAt >= from)
      .map((notice) => ({ kind: 'notice' as const, key: `notice-${notice.id}`, at: notice.createdAt, notice })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === 'notice' ? -1 : 1));
}

/**
 * The project's task announcements: the newest page from the route, merged on each refresh, and older
 * pages as far back as the loaded roots reach (all of them once every root is loaded). Announcements
 * are never removed, so the loaded ones are always the newest; a refresh that skipped past them reads
 * forward until it meets them, so no announcement between is missed.
 */
export function useTaskNotices(projectId: string, page: Page<TaskCreationNotice>, roots: ConversationRoot[], hasOlderRoots: boolean, onDenied: (cause: unknown) => void) {
  const [notices, setNotices] = useState(() => mergeNotices([], page.items));
  const [total, setTotal] = useState(page.total);
  const noticesRef = useRef(notices);
  const deniedRef = useRef(onDenied);
  const seen = useRef(page);
  useEffect(() => { noticesRef.current = notices; deniedRef.current = onDenied; });

  useEffect(() => {
    if (seen.current === page) return;
    seen.current = page;
    let cancelled = false;
    void (async () => {
      const known = new Set(noticesRef.current.map((notice) => notice.id));
      let incoming = page.items;
      let latestTotal = page.total;
      for (let index = 1; index < MAX_PAGES && known.size && incoming.length < latestTotal && !incoming.some((notice) => known.has(notice.id)); index += 1) {
        const next = await listTaskNotices(projectId, { offset: incoming.length, limit: PAGE });
        if (!next.items.length) break;
        incoming = [...incoming, ...next.items];
        latestTotal = next.total;
      }
      if (cancelled) return;
      setNotices((current) => mergeNotices(current, incoming));
      setTotal(latestTotal);
    })().catch((cause: unknown) => deniedRef.current(cause));
    return () => { cancelled = true; };
  }, [projectId, page]);

  // How far back the stream shows: the first loaded root while earlier roots remain, otherwise everything.
  const reach = hasOlderRoots ? roots[0]?.message.createdAt ?? null : '';
  const more = notices.length < total;
  // A failed read of earlier announcements is tried again a little later, not left missing.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!more || reach === null) return;
    const covered = () => !!noticesRef.current.length && reach !== '' && noticesRef.current[0]!.createdAt < reach;
    if (covered()) return;
    let cancelled = false;
    let timer = 0;
    void (async () => {
      let loaded = noticesRef.current;
      let latestTotal = total;
      for (let index = 0; index < MAX_PAGES && loaded.length < latestTotal; index += 1) {
        const next = await listTaskNotices(projectId, { offset: loaded.length, limit: PAGE });
        const merged = mergeNotices(loaded, next.items);
        latestTotal = next.total;
        if (merged.length === loaded.length) { latestTotal = loaded.length; break; }
        loaded = merged;
        if (reach !== '' && loaded[0]!.createdAt < reach) break;
      }
      if (cancelled) return;
      setNotices((current) => mergeNotices(current, loaded));
      setTotal(latestTotal);
    })().catch((cause: unknown) => {
      deniedRef.current(cause);
      if (!cancelled) timer = window.setTimeout(() => setRetry((value) => value + 1), 15000);
    });
    return () => { cancelled = true; window.clearTimeout(timer); };
    // `total` is read when more is needed, not followed: a refresh that only grows it never reads back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reach, more, retry]);

  return notices;
}

export interface ConversationRoots {
  roots: ConversationRoot[];
  hasOlder: boolean;
  olderBusy: boolean;
  loadOlder(): Promise<void>;
  /** A root the signed-in person just started. */
  posted(conversation: Conversation): void;
  /** The open thread's latest size, so the stream's count matches what the thread shows. */
  threadSize(conversationId: string, replyCount: number, lastReplyAt: string | null): void;
}

/**
 * The loaded roots: the newest window from the route, older windows on request, and the window
 * around a root that a link names. A refreshed newest window is merged, reading back when more roots
 * arrived than one window holds, so already loaded history never gets a hole.
 */
export function useConversationRoots(projectId: string, window: ConversationRootWindow, seek: string | null, onDenied: (cause: unknown) => void): ConversationRoots {
  const [roots, setRoots] = useState(window.roots);
  const [olderCursor, setOlderCursor] = useState(window.rootPage.nextBefore);
  const [olderBusy, setOlderBusy] = useState(false);
  const rootsRef = useRef(roots);
  const cursorRef = useRef(olderCursor);
  const deniedRef = useRef(onDenied);
  const seen = useRef(window);
  const windowRootsRef = useRef(window.roots);
  useEffect(() => { rootsRef.current = roots; cursorRef.current = olderCursor; deniedRef.current = onDenied; windowRootsRef.current = window.roots; });

  useEffect(() => {
    if (seen.current === window) return;
    seen.current = window;
    let cancelled = false;
    void (async () => {
      const known = new Set(rootsRef.current.map((root) => root.conversationId));
      let incoming = window.roots;
      let cursor = window.rootPage.nextBefore;
      for (let page = 0; page < MAX_PAGES && known.size && cursor && !incoming.some((root) => known.has(root.conversationId)); page += 1) {
        const older = await listConversationRoots(projectId, { before: cursor, limit: PAGE });
        incoming = [...older.roots, ...incoming];
        cursor = older.rootPage.nextBefore;
      }
      if (!cancelled) setRoots((current) => mergeRoots(current, incoming));
    })().catch((cause: unknown) => deniedRef.current(cause));
    return () => { cancelled = true; };
  }, [projectId, window]);

  // A link to a root older than the loaded window (search, inbox, "Since you left"): read back to it.
  useEffect(() => {
    // A root in the refreshed newest window (not merged yet) is newer, never older: nothing to read back.
    const loaded = (root: ConversationRoot) => root.conversationId === seek;
    if (!seek || rootsRef.current.some(loaded) || windowRootsRef.current.some(loaded) || !cursorRef.current) return;
    let cancelled = false;
    setOlderBusy(true);
    void (async () => {
      let cursor = cursorRef.current;
      const pages: ConversationRoot[] = [];
      for (let page = 0; page < MAX_PAGES && cursor; page += 1) {
        const older = await listConversationRoots(projectId, { before: cursor, limit: PAGE });
        pages.unshift(...older.roots);
        cursor = older.rootPage.nextBefore;
        if (older.roots.some((root) => root.conversationId === seek)) break;
      }
      if (cancelled) return;
      setRoots((current) => mergeRoots(current, pages));
      setOlderCursor(cursor);
    })().catch((cause: unknown) => deniedRef.current(cause)).finally(() => { if (!cancelled) setOlderBusy(false); });
    return () => { cancelled = true; setOlderBusy(false); };
  }, [projectId, seek]);

  const loadOlder = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    setOlderBusy(true);
    try {
      const page = await listConversationRoots(projectId, { before: cursor });
      setRoots((current) => mergeRoots(current, page.roots));
      setOlderCursor(page.rootPage.nextBefore);
    } finally { setOlderBusy(false); }
  }, [projectId]);

  const posted = useCallback((conversation: Conversation) => {
    const message = conversation.messages.find((item) => item.sequence === 1);
    if (!message) return;
    setRoots((current) => current.some((root) => root.conversationId === conversation.id) ? current
      : mergeRoots(current, [{ conversationId: conversation.id, message, replyCount: 0, lastReplyAt: null }]));
  }, []);

  const threadSize = useCallback((conversationId: string, replyCount: number, lastReplyAt: string | null) => {
    setRoots((current) => current.some((root) => root.conversationId === conversationId && (root.replyCount !== replyCount || root.lastReplyAt !== lastReplyAt))
      ? current.map((root) => root.conversationId === conversationId ? { ...root, replyCount, lastReplyAt } : root) : current);
  }, []);

  return { roots, hasOlder: !!olderCursor, olderBusy, loadOlder, posted, threadSize };
}

export interface StreamProps {
  project: Project;
  meId: string;
  roots: ConversationRoots;
  /** The loaded task announcements (UI116-3), oldest first. */
  notices: TaskCreationNotice[];
  work: ProjectWork;
  author: (message: ConversationMessage) => string;
  audience: string;
  /** The root whose thread is open beside the stream. */
  openId: string | null;
  /** A root to bring into view: a link named it, rather than the person choosing it here. */
  reveal: { conversationId: string; key: string } | null;
  /** The message a link points at (`#message-…`), when it is a root. */
  arrived: string | null;
  /** Increments when the person starts a root: the stream shows its newest message. */
  endToken: number;
  onOpen: (root: ConversationRoot, reply: boolean) => void;
  onDenied: (cause: unknown) => void;
}

/** The project's stream of roots, oldest first, with day dividers, each root's thread size and reply action. */
export function ConversationStream({ project, meId, roots: stream, notices, work, author, audience, openId, reveal, arrived, endToken, onOpen, onDenied }: StreamProps) {
  const { roots } = stream;
  const entries = streamEntries(roots, notices, stream.hasOlder);
  const writable = project.access !== 'viewer';
  const feedRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<number | null>(null);
  const pinRef = useRef<{ id: string; offset: number } | null>(null);
  /** The first entry in view and its offset from the top, as the reader last left it. */
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  const openRef = useRef(openId);
  useEffect(() => { openRef.current = openId; }, [openId]);
  // The root a person opens keeps its place while the thread docks beside the stream and leaves again.
  const openRoot = (root: ConversationRoot, reply: boolean) => {
    const feed = feedRef.current;
    const element = document.getElementById(`message-${root.message.id}`);
    if (feed && element) pinRef.current = { id: element.id, offset: element.getBoundingClientRect().top - feed.getBoundingClientRect().top };
    onOpen(root, reply);
  };
  const stickRef = useRef(!reveal);
  const [failure, setFailure] = useState('');
  const makeWork = useCreateWorkFromMessage(project);
  const { openDetails } = useShellActions();

  // Open on whole messages at the latest, unless a link names a root.
  useEffect(() => {
    const feed = feedRef.current;
    const column = columnRef.current;
    if (reveal || !feed || !column) return;
    return openOnWholeMessages(feed, column, '.project-convo__message');
    // Once, when the stream opens; later arrivals are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A linked root comes into view once it is loaded, and takes focus when the link named it exactly.
  const revealRoot = reveal ? roots.find((root) => root.conversationId === reveal.conversationId) ?? null : null;
  useEffect(() => {
    if (!revealRoot) return;
    const element = document.getElementById(`message-${revealRoot.message.id}`);
    if (!element) return;
    stickRef.current = false;
    element.scrollIntoView({ block: 'start' });
    if (arrived === revealRoot.message.id) element.focus({ preventScroll: true });
    // Once per link: later refreshes of the same root never move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.key, !!revealRoot]);

  // New entries follow the reader only while they are at the end. Anything else that joins the stream
  // (earlier roots, or announcements that arrive on their own between roots already shown) keeps the
  // entry the reader was looking at where it was. A changed reply count or edit (the same entries) never
  // moves the stream: a reply sent in an open thread must leave the root the person opened where it was.
  const lastKey = entries.at(-1)?.key ?? null;
  const firstKey = entries[0]?.key ?? null;
  const edgeRef = useRef({ first: firstKey, last: lastKey, count: entries.length });
  useLayoutEffect(() => {
    const feed = feedRef.current;
    const edge = edgeRef.current;
    const changed = lastKey !== edge.last || firstKey !== edge.first || entries.length !== edge.count;
    edgeRef.current = { first: firstKey, last: lastKey, count: entries.length };
    if (!feed) return;
    if (restoreRef.current !== null) { feed.scrollTop = feed.scrollHeight - restoreRef.current; restoreRef.current = null; return; }
    if (!changed) return;
    if (stickRef.current) { feed.scrollTop = feed.scrollHeight; return; }
    const anchor = anchorRef.current;
    const element = anchor ? document.getElementById(anchor.id) : null;
    if (anchor && element) feed.scrollTop += element.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset;
  }, [roots, firstKey, lastKey, entries.length]);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !endToken) return;
    stickRef.current = true;
    feed.scrollTop = feed.scrollHeight;
  }, [endToken]);

  // The thread docks beside the stream and leaves again: the root whose replies the person opened stays
  // at the same place (otherwise the first root in view, or the end when they were reading the end).
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    let width = feed.clientWidth;
    let frame = 0;
    // Only the person's own scrolling moves the opened root's place. A width change (the thread or Details
    // docking) makes the browser clamp the scroll position and this view adjust it; those scroll events
    // must not be taken for the reader moving, or the root would not come back to where it was.
    let personAt = -Infinity;
    const person = () => { personAt = performance.now(); };
    // A press on the scroll bar targets the feed itself; a press on a message or button does not scroll.
    const press = (event: PointerEvent) => { if (event.target === feed) person(); };
    const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    const key = (event: KeyboardEvent) => {
      if (scrollKeys.has(event.key) && !(event.target as Element | null)?.closest?.('button, a, input, textarea, select, [contenteditable]')) person();
    };
    const record = () => {
      frame = 0;
      const { top, bottom } = feed.getBoundingClientRect();
      stickRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
      if (performance.now() - personAt < 500) {
        const pinned = pinRef.current ? document.getElementById(pinRef.current.id)?.getBoundingClientRect() : null;
        pinRef.current = pinned && pinned.bottom > top && pinned.top < bottom ? { id: pinRef.current!.id, offset: pinned.top - top } : null;
      }
      anchorRef.current = null;
      for (const item of feed.querySelectorAll<HTMLElement>('.project-convo__message, .convo-notice')) {
        const box = item.getBoundingClientRect();
        if (box.bottom > top + 1) { anchorRef.current = { id: item.id, offset: box.top - top }; break; }
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(record); };
    // The stream's own content can also change height after a width change (the thread docking or
    // becoming a sheet re-renders a frame later): while a thread is open, its root keeps its place then too.
    const column = columnRef.current;
    let height = column?.offsetHeight ?? 0;
    const observer = new ResizeObserver(() => {
      const widened = feed.clientWidth !== width;
      const grown = !!column && column.offsetHeight !== height;
      if (!widened && !grown) return;
      width = feed.clientWidth;
      height = column?.offsetHeight ?? 0;
      const keep = widened ? pinRef.current ?? (stickRef.current ? null : anchorRef.current) : openRef.current ? pinRef.current : null;
      if (!widened && !keep) return;
      const element = keep ? document.getElementById(keep.id) : null;
      if (element && keep) feed.scrollTop += element.getBoundingClientRect().top - feed.getBoundingClientRect().top - keep.offset;
      else if (stickRef.current) feed.scrollTop = feed.scrollHeight;
      // The layout can still shift for a moment after a width change (a panel docking or leaving re-renders
      // a frame later), so the opened root is held in place until it settles, unless the person scrolls.
      if (widened && pinRef.current) { settleUntil = performance.now() + 1000; if (!settleFrame) settleFrame = requestAnimationFrame(holdPin); }
    });
    let settleUntil = 0;
    let settleFrame = 0;
    const holdPin = () => {
      settleFrame = 0;
      const keep = pinRef.current;
      if (!keep || performance.now() > settleUntil || performance.now() - personAt < 500) return;
      const element = document.getElementById(keep.id);
      if (element) {
        const drift = element.getBoundingClientRect().top - feed.getBoundingClientRect().top - keep.offset;
        if (Math.abs(drift) > 1) feed.scrollTop += drift;
      }
      settleFrame = requestAnimationFrame(holdPin);
    };
    record();
    feed.addEventListener('scroll', onScroll, { passive: true });
    for (const name of ['wheel', 'touchmove'] as const) feed.addEventListener(name, person, { passive: true });
    feed.addEventListener('pointerdown', press, { passive: true });
    feed.addEventListener('keydown', key);
    observer.observe(feed);
    if (column) observer.observe(column);
    return () => {
      feed.removeEventListener('scroll', onScroll);
      for (const name of ['wheel', 'touchmove'] as const) feed.removeEventListener(name, person);
      feed.removeEventListener('pointerdown', press);
      feed.removeEventListener('keydown', key);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (settleFrame) cancelAnimationFrame(settleFrame);
    };
  }, []);

  async function loadOlder() {
    const feed = feedRef.current;
    setFailure('');
    if (feed) restoreRef.current = feed.scrollHeight - feed.scrollTop;
    try { await stream.loadOlder(); }
    catch (cause) { restoreRef.current = null; onDenied(cause); setFailure('Earlier messages could not be loaded.'); }
  }

  const dayOf = entries.map((entry) => day(entry.at));
  return (
    <div className="project-convo__feed is-stream" ref={feedRef}>
      <div className="project-convo__in" data-shift ref={columnRef}>
        <section aria-label="Messages" className="project-convo__messages">
          {stream.hasOlder ? <Button variant="quiet" busy={stream.olderBusy} onClick={() => void loadOlder()}>Load earlier messages</Button> : null}
          {failure ? <p className="project-convo__error" role="alert">{failure} <button type="button" onClick={() => void loadOlder()}>Retry</button></p> : null}
          {entries.length ? (
            <ol className="project-convo__message-list">
              {entries.map((entry, index) => {
                const label = dayOf[index]!;
                const divider = index === 0 || dayOf[index - 1] !== label ? <li className="project-convo__day" key={`day-${entry.key}`}><span>{label}</span></li> : null;
                if (entry.kind === 'notice') return [divider, <NoticeItem key={entry.key} notice={entry.notice} meId={meId} work={work} onOpenTask={(id) => openDetails({ kind: 'work', id })} />];
                const { root } = entry;
                return [divider, <RootItem key={entry.key} root={root} project={project} meId={meId} author={author} work={work}
                  open={root.conversationId === openId} arrived={arrived === root.message.id} makeWork={makeWork} onOpen={openRoot}
                  onOpenResult={(resultId) => openDetails({ kind: 'result', id: resultId })} onDenied={onDenied} />];
              })}
            </ol>
          ) : stream.hasOlder ? null : writable
            ? <EmptyState icon="chat" title="Where do we start?"><p>Write a thought. You don’t need a topic or a ready plan. {audience === 'Only you' ? 'Only you see it for now; people you add to the project will see it too.' : `Everyone in ${project.name} sees it.`} Anything said here can later become work, a decision or a sketch.</p></EmptyState>
            : <EmptyState icon="chat" title="No messages yet"><p>You have read access to {project.name}. Messages appear here when someone writes. You can browse saved tasks, maps, docs and sources.</p></EmptyState>}
        </section>
      </div>
    </div>
  );
}

/** Who created a task, as the stream names people: "Ada · you", "Ada", "Scout · agent". */
function creatorName(creator: NamedPrincipal, meId: string) {
  if (creator.kind === 'agent') return `${creator.name ?? 'Agent'} · agent`;
  const name = creator.name ?? 'Member';
  return creator.id === meId ? `${name} · you` : name;
}

/**
 * One compact announcement that a task was created (UI116-3): who created it, its current title and a
 * link that opens exactly that task. It is not a message, so it has no replies or actions of its own.
 */
function NoticeItem({ notice, meId, work, onOpenTask }: { notice: TaskCreationNotice; meId: string; work: ProjectWork; onOpenTask: (workId: string) => void }) {
  const title = work.work.find((item) => item.id === notice.workId)?.title ?? notice.workTitle;
  return (
    <li className="convo-notice" id={`notice-${notice.id}`} data-work-id={notice.workId}>
      <span className="convo-notice__icon" aria-hidden="true"><Icon name="tasks" size={14} /></span>
      <span className="convo-notice__body">
        <span className="convo-notice__meta">New task · {creatorName(notice.createdBy, meId)}</span>
        <button type="button" className="convo-notice__task" onClick={() => onOpenTask(notice.workId)} aria-label={`Open task: ${title}`}>
          <span className="convo-notice__title">{title}</span><Icon name="chevron-right" size={14} />
        </button>
      </span>
      <time dateTime={notice.createdAt} title={when(notice.createdAt)}>{clock(notice.createdAt)}</time>
    </li>
  );
}

function RootItem({ root, project, meId, author, work, open, arrived, makeWork, onOpen, onOpenResult, onDenied }: {
  root: ConversationRoot; project: Project; meId: string; author: (message: ConversationMessage) => string; work: ProjectWork;
  open: boolean; arrived: boolean; makeWork: ReturnType<typeof useCreateWorkFromMessage>;
  onOpen: (root: ConversationRoot, reply: boolean) => void; onOpenResult: (resultId: string) => void; onDenied: (cause: unknown) => void;
}) {
  const { message } = root;
  const writable = project.access !== 'viewer';
  const mine = message.authorId === meId;
  const name = author(message);
  return (
    <li id={`message-${message.id}`} tabIndex={-1} data-conversation-id={root.conversationId}
      className={`project-convo__message${mine ? ' is-mine' : ''}${arrived ? ' is-arrived' : ''}${open ? ' is-open' : ''}`}>
      <Avatar name={name} size="md" tone={mine ? 'me' : 'neutral'} />
      <div className="project-convo__message-meta">
        <strong>{mine ? `${name} · you` : message.authorId === null ? name : <Link className="project-convo__person" to={`/dm/new?workspace=${project.workspaceId}&with=${message.authorId}`} title={`Message ${name} directly`}>{name}</Link>}</strong>
        <time dateTime={message.createdAt} title={when(message.createdAt)}>{clock(message.createdAt)}</time>
      </div>
      <p>{message.body}</p>
      {message.contribution ? <ContributionMark contribution={message.contribution} onOpenResult={onOpenResult} /> : null}
      {message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
      <MessageObjects messageId={message.id} lists={work} thread={root.task ?? null} />
      <Replies root={root} open={open} writable={writable} onOpen={(reply) => onOpen(root, reply)} />
      <MessageActions projectId={project.id} message={message} writable={writable} busy={makeWork.busy === message.id} onCreateWork={() => void makeWork.create(message)} />
      {makeWork.failed?.messageId === message.id ? <p className="ws-act-error" role="alert">{makeWork.failed.text} <button type="button" onClick={() => void makeWork.create(message)}>Retry</button></p> : null}
    </li>
  );
}

/** Under a root: how many replies its thread has, and the reply action. Both open the thread beside the stream. */
function Replies({ root, open, writable, onOpen }: { root: ConversationRoot; open: boolean; writable: boolean; onOpen: (reply: boolean) => void }) {
  const count = root.replyCount;
  if (!count && !writable) return null;
  const last = root.lastReplyAt ? (day(root.lastReplyAt) === 'Today' ? clock(root.lastReplyAt) : day(root.lastReplyAt)) : null;
  return (
    <div className="convo-replies">
      {count ? (
        <button type="button" className="convo-replies__open" aria-expanded={open} aria-controls={open ? 'thread' : undefined} onClick={() => onOpen(false)}>
          <Icon name="chat" size={13} />{count} {count === 1 ? 'reply' : 'replies'}{last ? <span className="convo-replies__when">· last {last}</span> : null}
        </button>
      ) : null}
      {writable ? (
        <button type="button" className="convo-replies__reply" aria-expanded={count ? undefined : open} aria-controls={open ? 'thread' : undefined} onClick={() => onOpen(true)}>
          {count ? null : <Icon name="chat" size={13} />}Reply
        </button>
      ) : null}
    </div>
  );
}
