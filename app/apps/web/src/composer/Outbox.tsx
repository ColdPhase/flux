import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../ui';
import { useConnection } from './connection';
import type { DraftFile, PendingSend } from './draft';
import { fileSize } from './Files';
import './composer.css';

/**
 * The state of a message the person sent (#264, HIG-59/66): on the message itself, quiet while it
 * goes ("Sending…", "Uploading…", "Waiting for connection") and an alert with Retry and Remove when
 * it was not sent. Nothing is shown once it is stored (HIG-69).
 */
export function OutboxStatus({ item, inline = false, onRetry, onRemove }: { item: PendingSend; inline?: boolean; onRetry: () => void; onRemove: () => void }) {
  if (item.state === 'failed') {
    return (
      <div className="outbox-status is-failed" role="alert">
        <Icon name="alert" size={13} />
        <span className="outbox-status__text">Not sent{item.error ? <span className="outbox-status__why">. {item.error}</span> : null}</span>
        <span className="outbox-status__acts">
          <button type="button" className="outbox-status__b" onClick={onRetry}>Retry</button>
          <button type="button" className="outbox-status__b" onClick={onRemove}>Remove</button>
        </span>
      </div>
    );
  }
  // In a meta row (where the stored message's time will be) it is a phrase, so it takes no extra line.
  if (inline && (item.state === 'sending' || item.state === 'uploading')) return <span className={`outbox-status is-${item.state}`}><span className="outbox-status__dot" aria-hidden="true" /><span className="outbox-status__text">{item.state === 'uploading' ? 'Uploading…' : 'Sending…'}</span></span>;
  return <PendingStatus item={item} onRetry={onRetry} onRemove={onRemove} />;
}

function PendingStatus({ item, onRetry, onRemove }: { item: PendingSend; onRetry: () => void; onRemove: () => void }) {
  const connection = useConnection();
  const label = item.state === 'uploading' ? 'Uploading…' : item.state === 'waiting' ? 'Waiting for connection' : 'Sending…';
  return (
    <div className={`outbox-status is-${item.state}`}>
      <span className="outbox-status__dot" aria-hidden="true" />
      <span className="outbox-status__text">{label}</span>
      {/* While the browser is online but Flux did not answer, the person may try now; offline, it goes on its own. */}
      {item.state === 'waiting' ? <span className="outbox-status__acts">
        {connection !== 'offline' ? <button type="button" className="outbox-status__b" onClick={onRetry}>Retry</button> : null}
        <button type="button" className="outbox-status__b" onClick={onRemove}>Remove</button>
      </span> : null}
    </div>
  );
}

/** The files of a message not stored yet: names only, since nothing can be downloaded before it is. */
export function PendingFiles({ files }: { files: readonly DraftFile[] }) {
  if (!files.length) return null;
  return <ol className="message-files is-pending" aria-label={files.length === 1 ? '1 attached file' : `${files.length} attached files`}>{files.map((file) => <li key={file.uploadId}>
    <span className="message-files__name"><Icon name="doc" size={14} /><span>{file.name}</span><small>{fileSize(file.size)}</small></span>
  </li>)}</ol>;
}

/** The cited material of a message not stored yet. */
export function PendingSource({ item, className = 'outbox-source' }: { item: PendingSend; className?: string }) {
  const ref = item.references[0];
  return ref ? <span className={className}>Source: {ref.title} · v{ref.version}</span> : null;
}

/**
 * One polite announcement per send: "Sending…" when a message is sent, and "Waiting for connection"
 * when it has to wait. Being stored says nothing; "Not sent" is an alert on the message.
 */
export function SendAnnouncer({ pending }: { pending: readonly PendingSend[] }) {
  const region = useRef<HTMLParagraphElement>(null);
  const said = useRef(new Map<string, string>());
  const timer = useRef(0);
  useEffect(() => {
    let next = '';
    for (const item of pending) {
      const now = item.state === 'waiting' ? 'Waiting for connection' : item.state === 'failed' ? null : 'Sending…';
      const before = said.current.get(item.id);
      if (!now || before === now || (before && now === 'Sending…')) continue;
      said.current.set(item.id, now);
      next = now;
    }
    const node = region.current;
    if (!next || !node) return;
    node.textContent = next;
    // Cleared after a moment, so the next send's same words are announced again.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { node.textContent = ''; }, 1500);
  }, [pending]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <p ref={region} className="ui-vh" role="status" aria-live="polite" data-send-announcer="" />;
}

// Several composers can be on screen (the stream and a docked thread): one of their lines is the live region.
const lines: symbol[] = [];
const lineListeners = new Set<() => void>();
const subscribeLines = (listener: () => void) => { lineListeners.add(listener); return () => { lineListeners.delete(listener); }; };

/** A quiet line above a composer while sends cannot reach Flux (HIG-67): why, and what happens to messages. */
export function ConnectionLine() {
  const state = useConnection();
  const [me] = useState(() => Symbol('connection-line'));
  useLayoutEffect(() => {
    lines.push(me);
    lineListeners.forEach((listener) => listener());
    return () => { lines.splice(lines.indexOf(me), 1); lineListeners.forEach((listener) => listener()); };
  }, [me]);
  const live = useSyncExternalStore(subscribeLines, () => lines[0] === me, () => false);
  const text = state === 'offline' ? 'You’re offline. Messages wait here and send when you’re back online.'
    : state === 'unreachable' ? 'Flux isn’t responding. Messages wait here and send when it’s back.' : '';
  // The live region stays in place and empty while online, so the line is announced when it appears.
  return <div className="connection-line-region" role={live ? 'status' : undefined} data-connection={state}>{text ? <p className="connection-line">{text}</p> : null}</div>;
}
