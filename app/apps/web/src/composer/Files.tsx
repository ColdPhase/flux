import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, Icon, useMediaQuery } from '../ui';
import { FileIcon, typeLine, useObjectUrl, warmPreview } from './Attachments';
import { selectedFile, uploadLabel, type ComposerState, type DraftFile } from './draft';
import { isVideoName, type FileLimits } from '@flux/contracts';
import { useFileLimits } from '../api/files';
import { detailLine, looksLikePhoto } from './fileKind';
import { useVideoPoster } from './videoPoster';
import './composer.css';

export { MessageFiles, MessageContent, hasPhotos, fileSize } from './Attachments';
export type { PhotoActions, PhotoContext } from './Attachments';

const fileStatus = (file: DraftFile, unconfirmed: boolean) => file.state === 'uploading' ? uploadLabel(file)
  : file.state === 'failed' ? 'Upload not confirmed'
    : unconfirmed ? 'Send unconfirmed; retry checks availability'
      : Date.parse(file.staged!.expiresAt) <= Date.now() ? 'Staging expired; select this file again' : 'Ready, private';

/**
 * Files chosen in the system's picker attach at once, in the order it returns them (on a phone it numbers the choices itself as they are made;
 * Flux asks nothing more, #1424). The draft's thumbnails carry the order on a touch screen ("Sends 1").
 */

/**
 * After files are attached the person is writing the message that carries them: the focus goes back to its field, as it was before the picker
 * (the dialog leaves it on the paperclip, where typing fired app shortcuts, #1424). Only where a keyboard is the way to type: a phone's field is
 * tapped, and focusing it would raise the keyboard and move the view under the person.
 */
function backToField(fieldId: string | undefined) {
  if (!fieldId || !window.matchMedia('(pointer: fine)').matches) return;
  const focus = () => { const field = document.getElementById(fieldId); if (field && !field.matches(':disabled')) field.focus({ preventScroll: true }); };
  focus();
  // Some engines give the focus back to the paperclip as the picker closes, after the change event.
  requestAnimationFrame(focus);
}

/** Staged files remain private until the exact message is confirmed. No bytes enter a helper prompt. */
/**
 * The attach control as one quiet paperclip, for composers that keep their tools inside the box
 * (#266 PF-3). Its accessible name stays "Attach files"; picked files join the same private draft.
 */
export function AttachButton({ state, disabled = false, className, fieldId }: { state: ComposerState; disabled?: boolean; className?: string; fieldId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const blocked = disabled || state.sending;
  return <>
    <input ref={input} className="ui-vh" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => {
        const files = [...event.currentTarget.files ?? []];
        event.currentTarget.value = '';
        if (blocked || !files.length) return;
        state.addFiles(files);
        backToField(fieldId);
      }} />
    <button type="button" className={['composer__attach', className].filter(Boolean).join(' ')} disabled={blocked} onClick={() => input.current?.click()}
      aria-label="Attach files" data-tip="Attach files · private until sent" data-tip-align="start"><Icon name="clip" size={16} /></button>
  </>;
}

/** `attach="none"` when the composer shows an {@link AttachButton} inside its box instead of the "Attach files" row. */
export function ComposerFiles({ state, disabled = false, attach = 'row' }: { state: ComposerState; disabled?: boolean; attach?: 'row' | 'none' }) {
  const input = useRef<HTMLInputElement>(null);
  const recovery = useRef<HTMLInputElement>(null);
  const recoverId = useRef<string | null>(null);
  const blocked = disabled || state.sending;
  const touch = useMediaQuery('(pointer: coarse)');
  const limits = useFileLimits();
  const empty = attach === 'none' && !state.draft.files.length && !state.draft.references.length && state.storage !== 'visit'
    && !(state.draft.unconfirmed && !state.sending && !state.error) && !state.error;
  return <div className="composer-files" hidden={empty || undefined}>
    <input ref={input} className="ui-vh" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => { if (!blocked) state.addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ''; }} />
    <input ref={recovery} className="ui-vh" type="file" tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!blocked && file && recoverId.current) state.retryFile(recoverId.current, file); event.currentTarget.value = ''; }} />
    {attach === 'row' ? <button type="button" className="composer-files__add" disabled={blocked} onClick={() => input.current?.click()} aria-label="Attach files"><Icon name="clip" size={14} />Attach files</button> : null}
    {state.draft.files.length ? <>
      <ol className="composer-files__list" aria-label="Files in your draft">{state.draft.files.map((file, index) => <DraftThumb key={file.uploadId} file={file} order={touch && state.draft.files.length > 1 ? index + 1 : 0}
        status={fileStatus(file, state.draft.unconfirmed)} blocked={blocked}
        onRetry={() => { if (!state.retryFile(file.uploadId)) { recoverId.current = file.uploadId; recovery.current?.click(); } }}
        onRemove={() => state.removeFile(file.uploadId)} />)}</ol>
      {limitsMatter(state, limits) ? <span className="composer-files__privacy" data-file-limits>{limitsLine(limits)}</span> : null}
    </> : null}
    {state.draft.references.map((ref) => <div key={`${ref.materialId}:${ref.version}`} className="composer-files__ref">
      <span>Source: {ref.title} · v{ref.version}</span><button type="button" className="composer-files__x" disabled={blocked} aria-label="Remove material citation" onClick={() => state.setReference(null)}><Icon name="x" size={14} /></button>
    </div>)}
    {state.storage === 'visit' ? <p className="composer-files__privacy">This browser refused draft storage. Your text, files and sources stay during this visit; keep this tab open to recover them.</p> : null}
    {state.draft.unconfirmed && !state.sending && !state.error ? <p className="composer-files__privacy">This send is unconfirmed. Retry sends the same command once.</p> : null}
    {state.error ? <p className="composer-files__error" role="alert">{state.error}</p> : null}
  </div>;
}

const mebibytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
const limitsLine = (limits: FileLimits) => `Private until sent · ${mebibytes(limits.fileBytes)} MiB each, videos ${mebibytes(limits.videoBytes)} MiB · ${limits.messageFiles} files / ${mebibytes(limits.messageBytes)} MiB per message`;

/** How close to a limit the draft is when its numbers are worth saying: two files short of the count, or four fifths of the bytes (#1424). */
const NEAR_BYTES = 0.8;

/**
 * The limits are said only when they matter: a file or the whole draft was refused, or the draft is near one. A draft of a file or two says
 * nothing about them (its rows already say "Ready, private"), so nothing stays under the composer the whole time files are attached.
 */
function limitsMatter(state: ComposerState, limits: FileLimits): boolean {
  const files = state.draft.files;
  if (state.error || files.some((file) => file.error)) return true;
  // The bytes of one message are counted as the draft counts them: the videos together against the video cap, every other file against the message's.
  const bytes = (video: boolean) => files.filter((file) => isVideoName(file.name) === video).reduce((total, file) => total + file.size, 0);
  return files.length >= limits.messageFiles - 2 || bytes(false) >= limits.messageBytes * NEAR_BYTES || bytes(true) >= limits.videoBytes * NEAR_BYTES;
}

/**
 * One draft file in the composer (#348): a photo as its thumbnail, any other file as its page icon,
 * with × to remove it. On a touch screen several choices are numbered in send order.
 */
function DraftThumb({ file, order, status, blocked, onRetry, onRemove }: { file: DraftFile; order: number; status: string; blocked: boolean; onRetry: () => void; onRemove: () => void }) {
  const local = looksLikePhoto(file.name) ? selectedFile(file.uploadId) : undefined;
  const url = useObjectUrl(local);
  // While the person can still read the file, a small copy of the photo is kept for its place in the queue if the message has to wait (#469).
  useEffect(() => { void warmPreview(local); }, [local]);
  const [broken, setBroken] = useState(false);
  // A video's poster (C-61) is its thumbnail once the browser has drawn it, as a photo's is.
  const poster = useVideoPoster(isVideoName(file.name) ? selectedFile(file.uploadId) : undefined);
  const shown = poster || (!broken ? url : '');
  const photo = !!shown;
  return <li className={`composer-thumb${photo ? ' is-photo' : ''}`} data-file-state={file.state}>
    <span className="composer-thumb__face">{photo ? <img src={shown} alt="" onError={() => setBroken(true)} /> : <FileIcon name={file.name} size={30} />}
      {order ? <span className="composer-thumb__order"><span className="ui-vh">Sends </span>{order}<span className="ui-vh">.</span></span> : null}</span>
    <span className="composer-files__name">{file.name}<small>{typeLine(file, detailLine(file.staged))} · {status}</small></span>
    {file.state === 'failed' ? <Button variant="outline" size="sm" className="composer-thumb__retry" disabled={blocked} onClick={onRetry}>Retry upload</Button> : null}
    <button type="button" className="composer-thumb__x" disabled={blocked} onClick={onRemove} aria-label={`Remove ${file.name}`}><span className="composer-thumb__xface"><Icon name="x" size={12} /></span></button>
    {file.error ? <p className="composer-files__error" role="alert">{file.error}</p> : null}
  </li>;
}

/**
 * Dropping files onto a conversation attaches them to its draft (#348). Spread the handlers on the
 * conversation; `dropping` marks it while files are held over it.
 */
export function useFileDrop(state: ComposerState, enabled: boolean) {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  if (!enabled) return { dropping: false, handlers: {} };
  return {
    dropping,
    handlers: {
      onDragEnter: (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); depth.current += 1; setDropping(true); },
      onDragOver: (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = state.sending ? 'none' : 'copy'; },
      onDragLeave: (event: DragEvent) => { if (!carriesFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDropping(false); },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault(); depth.current = 0; setDropping(false);
        const files = [...event.dataTransfer.files];
        if (files.length && !state.sending) state.addFiles(files);
      },
    },
  };
}
