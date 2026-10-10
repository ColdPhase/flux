import { useRef, useState, type DragEvent } from 'react';
import { Icon, useMediaQuery } from '../ui';
import { FileIcon, fileSize, useObjectUrl } from './Attachments';
import { selectedFile, uploadLabel, type ComposerState, type DraftFile } from './draft';
import { looksLikePhoto } from './fileKind';
import './composer.css';

export { MessageFiles, MessageContent, hasPhotos, fileSize } from './Attachments';
export type { PhotoActions, PhotoContext } from './Attachments';

const fileStatus = (file: DraftFile, unconfirmed: boolean) => file.state === 'uploading' ? uploadLabel(file)
  : file.state === 'failed' ? 'Upload not confirmed'
    : unconfirmed ? 'Send unconfirmed; retry checks availability'
      : Date.parse(file.staged!.expiresAt) <= Date.now() ? 'Staging expired; select this file again' : 'Ready, private';

/** Staged files remain private until the exact message is confirmed. No bytes enter a helper prompt. */
/**
 * The attach control as one quiet paperclip, for composers that keep their tools inside the box
 * (#266 PF-3). Its accessible name stays "Attach files"; picked files join the same private draft.
 */
export function AttachButton({ state, disabled = false, className }: { state: ComposerState; disabled?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const blocked = disabled || state.sending;
  return <>
    <input ref={input} className="ui-vh" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => { if (!blocked) state.addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ''; }} />
    <button type="button" className={['composer__attach', className].filter(Boolean).join(' ')} disabled={blocked} onClick={() => input.current?.click()}
      aria-label="Attach files" data-tip="Attach files · private until sent" data-tip-align="start"><Icon name="clip" size={17} /></button>
  </>;
}

/** `attach="none"` when the composer shows an {@link AttachButton} inside its box instead of the "Attach files" row. */
export function ComposerFiles({ state, disabled = false, attach = 'row' }: { state: ComposerState; disabled?: boolean; attach?: 'row' | 'none' }) {
  const input = useRef<HTMLInputElement>(null);
  const recovery = useRef<HTMLInputElement>(null);
  const recoverId = useRef<string | null>(null);
  const blocked = disabled || state.sending;
  const touch = useMediaQuery('(pointer: coarse)');
  const empty = attach === 'none' && !state.draft.files.length && !state.draft.references.length && state.storage !== 'visit'
    && !(state.draft.unconfirmed && !state.sending && !state.error) && !state.error;
  return <div className="composer-files" hidden={empty || undefined}>
    <input ref={input} className="ui-vh" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => { if (!blocked) state.addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = ''; }} />
    <input ref={recovery} className="ui-vh" type="file" tabIndex={-1} aria-hidden="true" disabled={blocked}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!blocked && file && recoverId.current) state.retryFile(recoverId.current, file); event.currentTarget.value = ''; }} />
    {attach === 'row' ? <button type="button" className="composer-files__add" disabled={blocked} onClick={() => input.current?.click()} aria-label="Attach files"><Icon name="plus" size={14} />Attach files</button> : null}
    {state.draft.files.length ? <>
      <span className="composer-files__privacy">Private until sent · 5 MiB each · 10 files / 20 MiB per message</span>
      <ol className="composer-files__list" aria-label="Files in your draft">{state.draft.files.map((file, index) => <DraftThumb key={file.uploadId} file={file} order={touch && state.draft.files.length > 1 ? index + 1 : 0}
        status={fileStatus(file, state.draft.unconfirmed)} blocked={blocked}
        onRetry={() => { if (!state.retryFile(file.uploadId)) { recoverId.current = file.uploadId; recovery.current?.click(); } }}
        onRemove={() => state.removeFile(file.uploadId)} />)}</ol>
    </> : null}
    {state.draft.references.map((ref) => <div key={`${ref.materialId}:${ref.version}`} className="composer-files__ref">
      <span>Source: {ref.title} · v{ref.version}</span><button type="button" disabled={blocked} aria-label="Remove material citation" onClick={() => state.setReference(null)}><Icon name="x" size={14} /></button>
    </div>)}
    {state.storage === 'visit' ? <p className="composer-files__privacy">This browser refused draft storage. Your text, files and sources stay during this visit; keep this tab open to recover them.</p> : null}
    {state.draft.unconfirmed && !state.sending && !state.error ? <p className="composer-files__privacy">This send is unconfirmed. Retry sends the same command once.</p> : null}
    {state.error ? <p className="composer-files__error" role="alert">{state.error}</p> : null}
  </div>;
}

/**
 * One draft file in the composer (#348): a photo as its thumbnail, any other file as its page icon,
 * with × to remove it. On a touch screen several choices are numbered in send order.
 */
function DraftThumb({ file, order, status, blocked, onRetry, onRemove }: { file: DraftFile; order: number; status: string; blocked: boolean; onRetry: () => void; onRemove: () => void }) {
  const local = looksLikePhoto(file.name) ? selectedFile(file.uploadId) : undefined;
  const url = useObjectUrl(local);
  const [broken, setBroken] = useState(false);
  const photo = !!url && !broken;
  return <li className={`composer-thumb${photo ? ' is-photo' : ''}`} data-file-state={file.state}>
    <span className="composer-thumb__face">{photo ? <img src={url} alt="" onError={() => setBroken(true)} /> : <FileIcon name={file.name} size={30} />}
      {order ? <span className="composer-thumb__order"><span className="ui-vh">Sends </span>{order}<span className="ui-vh">.</span></span> : null}</span>
    <span className="composer-files__name">{file.name}<small>{fileSize(file.size)} · {status}</small></span>
    {file.state === 'failed' ? <button type="button" className="composer-thumb__retry" disabled={blocked} onClick={onRetry}>Retry upload</button> : null}
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
