import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { filePath, imageTypeOf, type MessageFile } from '@flux/contracts';
import { Icon, trapTab, type IconName } from '../ui';
import { extensionOf, fileKind, fileLabel, fileWord, looksLikePhoto, type FileKind } from './fileKind';
import './attachments.css';

// Files, references and photos inside the message (#348, F-026 §6). Every byte is read through the
// ordinary download route, which checks the reader's current access on each request.

export const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;

/** The page icon with its folded corner: the pictogram below the fold and the mono label under it (PDF on an inverted band). */
export function FileIcon({ name, size = 28 }: { name: string; size?: number }) {
  const kind = fileKind(name);
  const label = fileLabel(name);
  const band = kind === 'pdf';
  return (
    <svg className={`file-icon file-icon--${kind}`} data-kind={kind} width={size * 0.8} height={size} viewBox="0 0 24 30" aria-hidden="true">
      <path className="file-icon__page" d="M4.5 1.25h10.25l6 6V27.5a1.25 1.25 0 01-1.25 1.25h-15a1.25 1.25 0 01-1.25-1.25v-25a1.25 1.25 0 011.25-1.25z" />
      <path className="file-icon__fold" d="M14.75 1.25V6a1.25 1.25 0 001.25 1.25h4.75" />
      <g className="file-icon__glyph">{PICTOGRAM[kind]}</g>
      {band ? <rect className="file-icon__band" x="3.25" y="21.5" width="17.5" height="6" /> : null}
      <text className={`file-icon__label${band ? ' is-band' : ''}`} x="12" y="26.4" textAnchor="middle">{label}</text>
    </svg>
  );
}

const PICTOGRAM: Record<FileKind, React.ReactNode> = {
  pdf: <path d="M8 10.5h8M8 13.25h8M8 16h5" />,
  document: <path d="M8 10.5h8M8 13.25h8M8 16h5" />,
  table: <><rect x="7" y="9.5" width="10" height="8" rx="1" /><path d="M7 12.2h10M7 14.8h10M10.3 9.5v8M13.7 9.5v8" /></>,
  sheet: <><rect x="7" y="9.5" width="10" height="8" rx="1" /><path d="M7 12.2h10M7 14.8h10M10.3 9.5v8M13.7 9.5v8" /></>,
  markdown: <path d="M6.75 17v-6.5l2.5 3 2.5-3V17M15.5 10.5V17M13.5 15l2 2 2-2" />,
  code: <path d="M9.5 10.5L7 13.5l2.5 3M14.5 10.5l2.5 3-2.5 3M12.8 10l-1.6 7" />,
  archive: <><path d="M12 8.25v.9M12 10.15v.9M12 12.05v.9" /><rect x="10.6" y="13.75" width="2.8" height="3.75" rx=".8" /></>,
  audio: <path d="M7 12.75v1.5M9 11v5M11 9.5v8M13 11.25v4.5M15 10v7M17 12.25v2.5" />,
  video: <><rect x="7" y="9.5" width="10" height="8" rx="2" /><path d="M11 11.5v4l3-2z" /></>,
  image: <><rect x="7" y="9.5" width="10" height="8" rx="1.5" /><path d="M7.5 16.75l3-3 2.25 2.25 1.5-1.5 2.25 2.25" /><circle cx="14.4" cy="11.9" r=".9" /></>,
  other: null,
};

export const typeLine = (file: { name: string; size: number }, detail?: string) => [fileWord(fileKind(file.name)), detail, fileSize(file.size)].filter(Boolean).join(' · ');

/** One stored file: icon, name, "type · size" and Download. The whole row downloads under its name. */
export function FileRow({ file }: { file: MessageFile }) {
  return (
    <a className="file-row" href={filePath(file.id)} download={file.name} data-file-kind={fileKind(file.name)}>
      <FileIcon name={file.name} />
      <span className="file-row__text"><span className="file-row__name">{file.name}</span><small>{typeLine(file)}</small></span>
      <span className="file-row__act" data-tip="Download"><Icon name="download" size={16} /><span className="ui-vh">Download</span></span>
    </a>
  );
}

/** Bytes of one stored file, read through the access-checked route. A photo is one only when its bytes are an image. */
type Bytes = { status: 'idle' | 'loading' } | { status: 'ready'; url: string; type: string } | { status: 'other' } | { status: 'denied' };
const AUDIO_TYPE: Record<string, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm' };
export function useFileBytes(fileId: string | null, as: 'image' | 'audio', enabled = true, name = ''): Bytes {
  const key = fileId && enabled ? `${fileId}:${as}:${name}` : '';
  const [result, setResult] = useState<{ key: string; bytes: Bytes }>({ key: '', bytes: { status: 'idle' } });
  useEffect(() => {
    if (!key || !fileId) return;
    const controller = new AbortController();
    let url = '';
    const settle = (bytes: Bytes) => setResult({ key, bytes });
    fetch(filePath(fileId), { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) { settle({ status: 'denied' }); return; }
      const data = new Uint8Array(await response.arrayBuffer());
      const type = as === 'image' ? imageTypeOf(data) : AUDIO_TYPE[extensionOf(name)] ?? 'audio/mpeg';
      if (!type) { settle({ status: 'other' }); return; }
      url = URL.createObjectURL(new Blob([data], { type }));
      settle({ status: 'ready', url, type });
    }).catch(() => { if (!controller.signal.aborted) settle({ status: 'denied' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [key, fileId, as, name]);
  if (!key) return { status: 'idle' };
  return result.key === key ? result.bytes : { status: 'loading' };
}

/** A local File (a draft or a message not stored yet) as an object URL for its thumbnail. */
export function useObjectUrl(blob: Blob | null | undefined) {
  const [state, setState] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    queueMicrotask(() => setState({ blob, url }));
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return blob && state?.blob === blob ? state.url : '';
}

/** Decorative waveform bars, steady for one file. */
function Waveform({ seed, bars = 22 }: { seed: string; bars?: number }) {
  const heights = useMemo(() => {
    let hash = 2166136261;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const out: number[] = [];
    for (let i = 0; i < bars; i++) { hash = Math.imul(hash ^ (hash >>> 13), 1274126177); out.push(3 + ((hash >>> 0) % 13)); }
    return out;
  }, [seed, bars]);
  return <svg className="voice-note__wave" width={bars * 4} height="18" viewBox={`0 0 ${bars * 4} 18`} aria-hidden="true">{heights.map((h, i) => <rect key={i} x={i * 4 + 1} y={(18 - h) / 2} width="2" height={h} rx="1" />)}</svg>;
}

const clockOf = (seconds: number) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}` : '';

/** A voice note: waveform and Play. Its bytes are read only when the reader presses Play. */
export function VoiceNote({ file }: { file: MessageFile }) {
  const [wanted, setWanted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const bytes = useFileBytes(wanted ? file.id : null, 'audio', wanted, file.name);
  useEffect(() => { if (bytes.status === 'ready' && wanted) void audio.current?.play().catch(() => setPlaying(false)); }, [bytes, wanted]);
  const toggle = () => {
    if (!wanted) { setWanted(true); return; }
    if (audio.current?.paused) void audio.current.play(); else audio.current?.pause();
  };
  return (
    <div className="file-row voice-note" data-file-kind="audio">
      <FileIcon name={file.name} />
      <span className="file-row__text"><span className="file-row__name">{file.name}</span>
        <small className="voice-note__line"><Waveform seed={file.id} />{bytes.status === 'denied' ? 'Unavailable' : duration || fileSize(file.size)}</small></span>
      <button type="button" className="voice-note__play" onClick={toggle} aria-pressed={playing} aria-label={`${playing ? 'Pause' : 'Play'} ${file.name}`} disabled={bytes.status === 'denied'}>
        <Icon name={playing ? 'pause' : 'play'} size={14} /></button>
      {bytes.status === 'ready' ? <audio ref={audio} src={bytes.url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => setDuration(clockOf(event.currentTarget.duration))} /> : null}
    </div>
  );
}

/** What the full-screen viewer can do with a photo's message. Each one is optional: a surface without it hides the action. */
export interface PhotoActions { onReply?: () => void; onCreateTask?: () => void }
export interface PhotoContext extends PhotoActions { author?: string; at?: string; caption?: string; place?: string }

/** One photo tile: the verified image, or the file row when the bytes are not an image. */
function PhotoTile({ file, index, count, more, onOpen }: { file: MessageFile; index: number; count: number; more: number; onOpen: (index: number) => void }) {
  const bytes = useFileBytes(file.id, 'image');
  if (bytes.status === 'other') return <li className="photo-grid__file"><FileRow file={file} /></li>;
  if (bytes.status === 'denied') return <li className="photo-grid__tile is-unavailable" data-photo-state="denied"><span>Photo unavailable</span></li>;
  return (
    <li className="photo-grid__tile" data-photo-state={bytes.status === 'ready' ? 'ready' : 'loading'}>
      <button type="button" className="photo-grid__open" onClick={() => onOpen(index)} disabled={bytes.status !== 'ready'}
        aria-label={`Open photo ${file.name}${count > 1 ? `, ${index + 1} of ${count}` : ''}${more ? `, ${more} more` : ''}`}>
        {bytes.status === 'ready' ? <img src={bytes.url} alt="" draggable={false} /> : null}
        {more ? <span className="photo-grid__more" aria-hidden="true">+{more}</span> : null}
      </button>
    </li>
  );
}

/** Photos without a file frame: radius 16, caption below; 2–4 form a grid with "+N" on the last one. */
export function PhotoGrid({ photos, context }: { photos: MessageFile[]; context?: PhotoContext }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = photos.slice(0, 4);
  const more = photos.length - shown.length;
  return (
    <div className={`photo-grid photo-grid--${Math.min(photos.length, 4)}`}>
      <ul className="photo-grid__tiles" aria-label={photos.length === 1 ? '1 photo' : `${photos.length} photos`}>
        {shown.map((file, index) => <PhotoTile key={file.id} file={file} index={index} count={photos.length} more={index === shown.length - 1 ? more : 0} onOpen={setOpen} />)}
      </ul>
      {open !== null ? <PhotoViewer photos={photos} start={open} context={context} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** A single photo's name and size, read after its caption (F-026 §6: caption first, then the meta line). */
export function PhotoMeta({ photos }: { photos: MessageFile[] }) {
  const only = photos.length === 1 ? photos[0] : undefined;
  return only ? <p className="photo-meta">{only.name} · {fileSize(only.size)}</p> : null;
}

/**
 * The full-screen viewer, always dark: who sent it and when, "1 of N", the caption, and Reply, Create
 * task, Save and Share. It reads the photo again on open, so a reader who lost access sees nothing.
 */
export function PhotoViewer({ photos, start, context, onClose }: { photos: MessageFile[]; start: number; context?: PhotoContext; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [note, setNote] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const file = photos[index]!;
  const bytes = useFileBytes(file.id, 'image');
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    const close = root.current?.querySelector<HTMLElement>('.photo-viewer__close');
    close?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; (returnTo.current as HTMLElement | null)?.focus?.(); };
  }, []);
  const step = useCallback((by: number) => { setNote(''); setIndex((value) => Math.min(photos.length - 1, Math.max(0, value + by))); }, [photos.length]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1); return; }
    trapTab(event, root.current);
  };
  const share = async () => {
    const link = new URL(window.location.href).toString();
    try {
      if (bytes.status === 'ready' && navigator.canShare) {
        const shared = new File([await (await fetch(bytes.url)).blob()], file.name, { type: bytes.type });
        if (navigator.canShare({ files: [shared] })) { await navigator.share({ files: [shared], title: file.name }); return; }
      }
      if (navigator.share) { await navigator.share({ title: file.name, url: link }); return; }
      await navigator.clipboard.writeText(link);
      setNote('Link copied');
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setNote('Could not share');
    }
  };
  const actions: { key: string; icon: IconName; label: string; run?: () => void }[] = [
    { key: 'reply', icon: 'reply', label: 'Reply', run: context?.onReply },
    { key: 'task', icon: 'add-task', label: 'Create task', run: context?.onCreateTask },
  ];
  const meta = [context?.at ? new Date(context.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null, photos.length > 1 ? `${index + 1} of ${photos.length}` : null].filter(Boolean).join(' · ');
  return createPortal(
    <div ref={root} className="photo-viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} data-theme-fixed="dark">
      <div className="photo-viewer__top">
        <button type="button" className="photo-viewer__round photo-viewer__close" onClick={onClose} aria-label="Close photo"><Icon name="x" size={18} /></button>
        <div className="photo-viewer__who"><strong id={titleId}>{context?.author ?? file.name}</strong>{meta ? <span>{meta}</span> : null}</div>
        <span className="photo-viewer__spacer" aria-hidden="true" />
      </div>
      <div className="photo-viewer__stage">
        {photos.length > 1 ? <button type="button" className="photo-viewer__round photo-viewer__prev" onClick={() => step(-1)} disabled={index === 0} aria-label="Previous photo"><Icon name="chevron-left" size={18} /></button> : null}
        {bytes.status === 'ready' ? <img src={bytes.url} alt={context?.caption || file.name} />
          : <p className="photo-viewer__empty" role={bytes.status === 'denied' ? 'alert' : undefined}>{bytes.status === 'denied' ? 'You no longer have access to this photo.' : bytes.status === 'other' ? 'This file is not a photo.' : 'Loading…'}</p>}
        {photos.length > 1 ? <button type="button" className="photo-viewer__round photo-viewer__next" onClick={() => step(1)} disabled={index === photos.length - 1} aria-label="Next photo"><Icon name="chevron-right" size={18} /></button> : null}
      </div>
      {photos.length > 1 ? <div className="photo-viewer__dots" aria-hidden="true">{photos.map((photo, i) => <span key={photo.id} className={i === index ? 'is-on' : undefined} />)}</div> : null}
      <div className="photo-viewer__caption">
        {context?.caption ? <p>{context.caption}</p> : null}
        <small>{[file.name, fileSize(file.size), context?.place ? `in ${context.place}` : null].filter(Boolean).join(' · ')}</small>
        <span className="photo-viewer__note" role="status">{note}</span>
      </div>
      <div className="photo-viewer__actions" role="group" aria-label="Photo actions">
        {actions.filter((item) => item.run).map((item) => <button key={item.key} type="button" onClick={() => {
          // The action takes focus where it leads (the composer, the new task), so the opener does not take it back.
          returnTo.current = null; onClose(); item.run?.();
        }}><Icon name={item.icon} size={20} />{item.label}</button>)}
        <a href={filePath(file.id)} download={file.name}><Icon name="download" size={20} />Save</a>
        <button type="button" onClick={() => void share()} disabled={bytes.status !== 'ready'}><Icon name="share" size={20} />Share</button>
      </div>
    </div>, document.body);
}

/**
 * Ordered stored files shared by roots, replies, Details and Agents (#154, #348): photos first as a
 * frameless grid, then file rows and voice notes. Each file downloads under its name.
 */
export function MessageFiles({ files, context }: { files?: MessageFile[]; context?: PhotoContext }) {
  if (!files?.length) return null;
  const photos = files.filter((file) => looksLikePhoto(file.name));
  const others = files.filter((file) => !looksLikePhoto(file.name));
  return <>
    {photos.length ? <PhotoGrid photos={photos} context={context} /> : null}
    {others.length ? <ol className="message-files" aria-label={others.length === 1 ? '1 attached file' : `${others.length} attached files`}>{others.map((file) => <li key={file.id}>
      {fileKind(file.name) === 'audio' ? <VoiceNote file={file} /> : <FileRow file={file} />}
    </li>)}</ol> : null}
    <PhotoMeta photos={photos} />
  </>;
}

/** The media comes first; its caption, file rows and native references share one message bubble, then a single photo's meta. */
export function MessageContent({ files, context, body, children }: { files?: MessageFile[]; context?: PhotoContext; body?: ReactNode; children?: ReactNode }) {
  const photos = files?.filter((file) => looksLikePhoto(file.name)) ?? [];
  const others = files?.filter((file) => !looksLikePhoto(file.name));
  return <>
    {photos.length ? <PhotoGrid photos={photos} context={context} /> : null}
    <div className="message-bubble">{body}<MessageFiles files={others} />{children}</div>
    <PhotoMeta photos={photos} />
  </>;
}

/** Whether a list of draft or sent files holds anything shown as a photo. */
export const hasPhotos = (files: readonly { name: string }[] | undefined) => !!files?.some((file) => looksLikePhoto(file.name));
