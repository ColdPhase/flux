import { useRef } from 'react';
import { filePath, type MessageFile } from '@flux/contracts';
import { Icon } from '../ui';
import type { ComposerState, DraftFile } from './draft';
import './composer.css';

export const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
const fileStatus = (file: DraftFile, unconfirmed: boolean) => file.state === 'uploading' ? 'Uploading…'
  : file.state === 'failed' ? 'Upload not confirmed'
    : unconfirmed ? 'Send unconfirmed; retry checks availability'
      : Date.parse(file.staged!.expiresAt) <= Date.now() ? 'Staging expired; select this file again' : 'Ready, private';

/** Ordered stored-file links shared by roots, replies, Details and Agents; each one downloads under its name. */
export function MessageFiles({ files }: { files?: MessageFile[] }) {
  if (!files?.length) return null;
  return <ol className="message-files" aria-label={files.length === 1 ? '1 attached file' : `${files.length} attached files`}>{files.map((file) => <li key={file.id}>
    <a href={filePath(file.id)} download={file.name}><Icon name="doc" size={14} /><span>{file.name}</span><small>{fileSize(file.size)}</small></a>
  </li>)}</ol>;
}

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
      <ol className="composer-files__list" aria-label="Files in your draft">{state.draft.files.map((file) => <li key={file.uploadId}>
        <span className="composer-files__name">{file.name}<small>{fileSize(file.size)} · {fileStatus(file, state.draft.unconfirmed)}</small></span>
        {file.state === 'failed' ? <button type="button" disabled={blocked} onClick={() => {
          if (!state.retryFile(file.uploadId)) { recoverId.current = file.uploadId; recovery.current?.click(); }
        }}>Retry upload</button> : null}
        <button type="button" disabled={blocked} onClick={() => state.removeFile(file.uploadId)} aria-label={`Remove ${file.name}`}><Icon name="x" size={14} /></button>
        {file.error ? <p className="composer-files__error" role="alert">{file.error}</p> : null}
      </li>)}</ol>
    </> : null}
    {state.draft.references.map((ref) => <div key={`${ref.materialId}:${ref.version}`} className="composer-files__ref">
      <span>Source: {ref.title} · v{ref.version}</span><button type="button" disabled={blocked} aria-label="Remove material citation" onClick={() => state.setReference(null)}><Icon name="x" size={14} /></button>
    </div>)}
    {state.storage === 'visit' ? <p className="composer-files__privacy">This browser refused draft storage. Your text, files and sources stay during this visit; keep this tab open to recover them.</p> : null}
    {state.draft.unconfirmed && !state.sending && !state.error ? <p className="composer-files__privacy">This send is unconfirmed. Retry sends the same command once.</p> : null}
    {state.error ? <p className="composer-files__error" role="alert">{state.error}</p> : null}
  </div>;
}
