import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ConversationMessage } from '@flux/contracts';
import { AgentIdentity, Avatar, Icon } from '../ui';
import type { PendingSend } from '../composer/draft';
import { OutboxStatus, PendingFiles, PendingSource } from '../composer/Outbox';
import { getMaterialVersion } from './conversation-api';
import { readerActive, watchReaderInput } from '../work/readerIntent';

// Pieces of a project message shared by the stream of roots and the thread beside it (UI116-1).

export function when(iso: string) { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export function clock(iso: string) { return clockFormat.format(new Date(iso)); }
export function day(iso: string) {
  const date = new Date(iso);
  return new Date().toDateString() === date.toDateString() ? 'Today' : dayFormat.format(date);
}

/** Longest a feed waits for its first chips, references and state line before it shows (#155). */
export const OPENING_REVEAL_MS = 1000;

/**
 * Opens a feed on whole messages at its latest: when the latest screen would start mid-message, it begins at
 * the next message instead, with a little room below the last one (direction C "return anchor"). Layout
 * settles as lines, fonts and late message previews arrive, so this repeats until the reader acts. Only
 * genuine reader input ends it (readerIntent.ts, #155), or a scroll settle() did not write that follows such
 * input; layout growth, scroll anchoring and other writers never end it. Returns the cleanup.
 */
export function openOnWholeMessages(feed: HTMLElement, column: HTMLElement, selector: string): () => void {
  let written = -1;
  const settle = () => {
    column.style.paddingBottom = '';
    feed.scrollTop = feed.scrollHeight;
    written = feed.scrollTop;
    const top = feed.getBoundingClientRect().top;
    const list = [...feed.querySelectorAll<HTMLElement>(selector)];
    const index = list.findIndex((item) => { const box = item.getBoundingClientRect(); return box.top < top - 1 && box.bottom > top + 1; });
    if (index < 0) return;
    const next = list[index + 1];
    if (!next) { list[index]!.scrollIntoView({ block: 'start' }); written = feed.scrollTop; return; }
    const delta = next.getBoundingClientRect().top - top;
    if (delta <= 0) return;
    column.style.paddingBottom = `${parseFloat(getComputedStyle(column).paddingBottom) + delta}px`;
    feed.scrollTop = feed.scrollHeight;
    written = feed.scrollTop;
  };
  settle();
  const observer = new ResizeObserver(() => settle());
  observer.observe(feed);
  observer.observe(column.firstElementChild ?? column);
  const stop = () => observer.disconnect();
  const release = watchReaderInput(feed, stop);
  const moved = () => { if (Math.abs(feed.scrollTop - written) > 1 && readerActive(feed)) stop(); };
  const timer = window.setTimeout(stop, 2000);
  feed.addEventListener('scroll', moved, { passive: true });
  return () => { stop(); release(); window.clearTimeout(timer); feed.removeEventListener('scroll', moved); };
}

/**
 * What an explicit native effect contributed to a task thread: a saved blocker, a published result (a link to
 * that exact canonical result) or an explicit public handoff. Ordinary replies show no marker.
 */
export function ContributionMark({ contribution, onOpenResult }: { contribution: NonNullable<ConversationMessage['contribution']>; onOpenResult: (resultId: string) => void }) {
  if (contribution.kind === 'result') {
    return <button type="button" className="project-convo__source project-convo__contribution" data-contribution="result" onClick={() => onOpenResult(contribution.resultId)}><Icon name="result" size={13} />Result · open details</button>;
  }
  return <span className="project-convo__source project-convo__contribution" data-contribution={contribution.kind}>{contribution.kind === 'blocker' ? 'Saved as the task blocker' : 'Handoff instruction'}</span>;
}

export function SourceCitation({ materialId, version, onDenied }: { materialId: string; version: number; onDenied: (cause: unknown) => void }) {
  const [title, setTitle] = useState('Material');
  const onDeniedRef = useRef(onDenied);
  useEffect(() => { onDeniedRef.current = onDenied; }, [onDenied]);
  useEffect(() => { const controller = new AbortController(); getMaterialVersion(materialId, version, controller.signal).then((item) => setTitle(item.title)).catch((cause: unknown) => { if (!controller.signal.aborted) { onDeniedRef.current(cause); setTitle('Material unavailable'); } }); return () => controller.abort(); }, [materialId, version]);
  return <Link to={`/materials/${materialId}/versions/${version}`} className="project-convo__source">Source: {title} · v{version}</Link>;
}

export { AuthorFace } from '../ui';

/** An agent author's name line: its name, the "Agent" tag and "for <owner>" when the reader may know it. */
export function AgentAuthor({ message, owner }: { message: Extract<ConversationMessage, { authorId: null }>; owner?: string | null }) {
  return <AgentIdentity name={message.author.name ?? 'Agent'} owner={owner} icon={false} />;
}

/**
 * The person's own message from the moment they press Send until it is stored (#264): at the end of
 * the stream or thread, shaped like the stored message that replaces it. It is a plain list item (not
 * a component of its own), so the stored message with the same key reuses it and nothing is redrawn.
 */
export function pendingMessageRow({ item, name, place, keyed = true, onRetry, onRemove }: {
  item: PendingSend; name: string; place: 'stream' | 'thread';
  /** False when a component returns it: its key then sits on that component, as on the stored message's. */
  keyed?: boolean; onRetry: () => void; onRemove: () => void;
}) {
  // In a thread "Sending…" stands where the time will be, and in the stream where the reply row will be,
  // so the stored message takes exactly the queued one's space. Retry and Remove need their own row.
  const inMeta = place === 'thread' && (item.state === 'sending' || item.state === 'uploading');
  const status = <OutboxStatus inline={inMeta} item={item} onRetry={onRetry} onRemove={onRemove} />;
  return (
    <li key={keyed ? `pending-${item.id}` : undefined} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
      className={`project-convo__message is-mine is-pending is-pending-${place}${item.state === 'failed' ? ' is-failed-send' : ''}`}>
      <Avatar name={name} size="lg" tone="me" />
      <div className="project-convo__message-meta"><strong>{name} · you</strong>{inMeta ? status : null}</div>
      <PendingFiles body={item.body ? <p>{item.body}</p> : null} files={item.files} send={{ state: item.state, onRetry }} />
      <PendingSource item={item} className="project-convo__source" />
      {inMeta ? null : status}
    </li>
  );
}
