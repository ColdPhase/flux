import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from '../ui';
import { useConnection } from './connection';
import type { DraftFile, PendingSend } from './draft';
import { FileIcon, typeLine, useObjectUrl } from './Attachments';
import { selectedFile, uploadLabel } from './draft';
import { looksLikePhoto } from './fileKind';
import './composer.css';

/**
 * The state of a message the person sent (#264, HIG-59/66): on the message itself, quiet while it
 * goes ("Sending…", "Uploading…", "Waiting to send") and an alert with Retry and Remove when
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
  const label = item.state === 'uploading' ? 'Uploading…' : item.state === 'waiting' ? 'Waiting to send' : 'Sending…';
  return (
    <div className={`outbox-status is-${item.state}`}>
      {item.state === 'waiting' ? <Icon name="clock" size={13} /> : <span className="outbox-status__dot" aria-hidden="true" />}
      <span className="outbox-status__text">{label}{item.state === 'waiting' && item.error ? <span className="outbox-status__why">. {item.error}</span> : null}</span>
      {/* While the browser is online but Flux did not answer, the person may try now; offline, it goes on its own. */}
      {item.state === 'waiting' ? <span className="outbox-status__acts">
        {connection !== 'offline' ? <button type="button" className="outbox-status__b" onClick={onRetry}>Retry</button> : null}
        <button type="button" className="outbox-status__b" onClick={onRemove}>Remove</button>
      </span> : null}
    </div>
  );
}

/**
 * The files of a message not stored yet: nothing can be downloaded before it is. Photos show from the
 * picked bytes with the send state on the photo itself (#348): sending, "sends when you're back", Retry.
 * The on-photo Retry repeats the message's own Retry for the pointer, so assistive technology hears one.
 */
export function PendingFiles({ files, send, body }: { files: readonly DraftFile[]; send?: { state: PendingSend['state']; onRetry: () => void }; body?: ReactNode }) {
  const photos = files.filter((file) => looksLikePhoto(file.name) && selectedFile(file.uploadId));
  const others = files.filter((file) => !photos.includes(file));
  return <>
    {photos.length ? <div className={`photo-grid photo-grid--${Math.min(photos.length, 4)} is-pending`}>
      <ul className="photo-grid__tiles" aria-label={photos.length === 1 ? '1 photo' : `${photos.length} photos`}>
        {photos.slice(0, 4).map((file, index) => <PendingPhoto key={file.uploadId} file={file} send={send} more={index === 3 ? photos.length - 4 : 0} />)}
      </ul>
    </div> : null}
    <div className="message-bubble">{body}
      {others.length ? <ol className="message-files is-pending" aria-label={others.length === 1 ? '1 attached file' : `${others.length} attached files`}>{others.map((file) => <li key={file.uploadId}>
        <span className="file-row"><FileIcon name={file.name} /><span className="file-row__text"><span className="file-row__name">{file.name}</span><small>{typeLine(file)}{file.state === 'uploading' ? ` · ${uploadLabel(file)}` : null}</small></span></span>
      </li>)}</ol> : null}
    </div>
  </>;
}

/** The share of bytes sent, as a ring that fills (its words beside it say the number). */
function Meter({ percent }: { percent: number }) {
  return <svg className="photo-grid__meter" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
    <circle className="photo-grid__meter-track" cx="15" cy="15" r="12" />
    <circle className="photo-grid__meter-bar" cx="15" cy="15" r="12" pathLength={100} strokeDasharray={`${percent} 100`} transform="rotate(-90 15 15)" />
  </svg>;
}

function PendingPhoto({ file, send, more }: { file: DraftFile; send?: { state: PendingSend['state']; onRetry: () => void }; more: number }) {
  const url = useObjectUrl(selectedFile(file.uploadId));
  const state = send?.state ?? 'sending';
  // Its own bytes: a percentage while they go out, then "Sending" once all are out until the message is confirmed (#348).
  const uploading = file.state === 'uploading' && state !== 'failed' && state !== 'waiting';
  return <li className="photo-grid__tile" data-photo-state={state}>
    <span className="photo-grid__open">
      {url ? <img src={url} alt={file.name} draggable={false} /> : null}
      {more ? <span className="photo-grid__more" aria-hidden="true">+{more}</span> : null}
      <span className="photo-grid__state" aria-hidden="true">
        {state === 'failed' ? <button type="button" tabIndex={-1} className="photo-grid__retry" onClick={send?.onRetry}>Retry</button>
          : state === 'waiting' ? <><Icon name="clock" size={22} /><span>Sends when you're back</span></>
            : uploading && (file.progress ?? 0) < 100 ? <><Meter percent={file.progress ?? 0} /><span data-upload-progress={file.progress ?? 0}>{uploadLabel(file)}</span></>
              : <><span className="photo-grid__ring" /><span>Sending</span></>}
      </span>
    </span>
  </li>;
}

/** The cited material of a message not stored yet. */
export function PendingSource({ item, className = 'outbox-source' }: { item: PendingSend; className?: string }) {
  const ref = item.references[0];
  return ref ? <span className={className}>Source: {ref.title} · v{ref.version}</span> : null;
}

/**
 * One polite announcement per send: "Sending…" when a message is sent, and "Waiting to send"
 * when it has to wait. Being stored says nothing; "Not sent" is an alert on the message.
 */
export function SendAnnouncer({ pending }: { pending: readonly PendingSend[] }) {
  const region = useRef<HTMLParagraphElement>(null);
  const said = useRef(new Map<string, string>());
  const timer = useRef(0);
  useEffect(() => {
    let next = '';
    for (const item of pending) {
      const now = item.state === 'waiting' ? 'Waiting to send' : item.state === 'failed' ? null : 'Sending…';
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

// Several composers can be on screen (the stream and a docked thread): the newest one's line shows and is the live region
// (on the phone the thread covers the stream).
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
  const live = useSyncExternalStore(subscribeLines, () => lines[lines.length - 1] === me, () => false);
  const text = state === 'offline' ? 'You’re offline. Messages send when you’re back.'
    : state === 'unreachable' ? 'Flux isn’t responding. Messages wait here and send when it’s back.' : '';
  // The live region stays in place and empty while online, so the line is announced when it appears.
  // One line per screen: only the newest composer's line shows it.
  return <div className="connection-line-region" role={live ? 'status' : undefined} data-connection={state}>{text && live ? <p className="connection-line">{text}</p> : null}</div>;
}
