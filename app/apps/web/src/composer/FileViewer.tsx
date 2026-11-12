import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { filePath, filePreviewPath, type MessageFile } from '@flux/contracts';
import { send } from '../api/client';
import { readFileBytes } from '../api/files';
import { Button, Icon, Spinner, trapTab } from '../ui';
import { fileKind, fileSize, fileWord, type PreviewFormat } from './fileKind';
import type { ParsedFormat, PreviewModel } from './previewParse';
import { JsonErrorView, JsonView, TableView, TextView, hiddenColumns, tableRows } from './previewViews';

// A file preview in the photo viewer's frame (C-60, #1252, F-026 §6): always dark, Close, the name with "type · size", Download.
// Someone else's HTML never runs on Flux's origin: it is framed from the preview route, which sandboxes it to an opaque origin
// and lets it fetch nothing; the frame's own `sandbox` attribute says the same. Text, JSON and tables are read through the download
// route, parsed in a Web Worker and drawn as text.

/** No feature a page could ask the browser for: Flux may hold the camera and microphone for a call, the preview never does. */
const NOTHING_ALLOWED = "camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; clipboard-read 'none'; clipboard-write 'none'";

type Access = 'checking' | 'ready' | 'denied';

/**
 * The reader's access to the file, asked again on every open with the download's own check (a HEAD of the download: no bytes travel),
 * so a person who lost access sees that, not a framed error. The frame's own read is checked again by the preview route.
 */
function useAccess(fileId: string, enabled: boolean): Access {
  const [state, setState] = useState<{ id: string; access: Access }>({ id: '', access: 'checking' });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    send(filePath(fileId), { method: 'HEAD', leavesReads: true, cache: 'no-store', signal: controller.signal })
      .then((response) => setState({ id: fileId, access: response.ok ? 'ready' : 'denied' }))
      .catch(() => { if (!controller.signal.aborted) setState({ id: fileId, access: 'denied' }); });
    return () => controller.abort();
  }, [fileId, enabled]);
  return state.id === fileId ? state.access : 'checking';
}

type Parsed = { status: 'loading' } | { status: 'denied' } | { status: 'failed' } | { status: 'ready'; model: PreviewModel };

/** The file's bytes through the download route (its access check), parsed in a Web Worker so a large file never holds the page. */
function useParsed(fileId: string, format: ParsedFormat | null): Parsed {
  const key = format ? `${fileId}:${format}` : '';
  const [state, setState] = useState<{ key: string; parsed: Parsed }>({ key: '', parsed: { status: 'loading' } });
  useEffect(() => {
    if (!key || !format) return;
    const controller = new AbortController();
    let worker: Worker | null = null;
    const settle = (parsed: Parsed) => { if (!controller.signal.aborted) setState({ key, parsed }); };
    readFileBytes(fileId, { signal: controller.signal, cache: 'no-store' }).then((bytes) => {
      if (!bytes) { settle({ status: 'denied' }); return; }
      if (controller.signal.aborted) return;
      worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ model?: PreviewModel; error?: string }>) => {
        settle(event.data.model ? { status: 'ready', model: event.data.model } : { status: 'failed' });
        worker?.terminate();
      };
      worker.onerror = () => settle({ status: 'failed' });
      const buffer = bytes.buffer as ArrayBuffer;
      worker.postMessage({ bytes: buffer, format }, [buffer]);
    }).catch(() => settle({ status: 'denied' }));
    return () => { controller.abort(); worker?.terminate(); };
  }, [key, fileId, format]);
  if (!key) return { status: 'loading' };
  return state.key === key ? state.parsed : { status: 'loading' };
}

/** The HTML page as its author wrote it, in a sandboxed frame; scripts run only after the person's Run scripts, for this preview. */
function HtmlPage({ file, scripts }: { file: MessageFile; scripts: boolean }) {
  return <iframe key={scripts ? 'scripts' : 'still'} className="file-viewer__frame" title={`Preview of ${file.name}`}
    src={filePreviewPath(file.id, scripts)} sandbox={scripts ? 'allow-scripts' : ''} allow={NOTHING_ALLOWED} referrerPolicy="no-referrer" />;
}

/**
 * A PDF in the browser's own viewer. The frame is sandboxed by the preview's policy only: Chromium shows no PDF in a frame with the
 * `sandbox` attribute (C-60). A browser without a PDF viewer (Android) says so and offers Download.
 */
function PdfPage({ file }: { file: MessageFile }) {
  if (navigator.pdfViewerEnabled === false) return (
    <div className="file-viewer__state file-viewer__state--column">
      <p>This browser can't show a PDF here.</p>
      <a className="ui-btn ui-btn--primary" href={filePath(file.id)} download={file.name}><Icon name="download" />Download</a>
    </div>
  );
  return <iframe className="file-viewer__frame" title={`Preview of ${file.name}`} src={filePreviewPath(file.id)} allow={NOTHING_ALLOWED} referrerPolicy="no-referrer" />;
}

const PARSED: Partial<Record<PreviewFormat, ParsedFormat>> = { text: 'text', json: 'json', csv: 'csv', tsv: 'tsv' };

export function FileViewer({ file, format, onClose }: { file: MessageFile; format: PreviewFormat; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<Element | null>(null);
  const [scripts, setScripts] = useState(false);
  const [source, setSource] = useState(false);
  const [numbers, setNumbers] = useState(false);
  const framed = (format === 'html' && !source) || format === 'pdf';
  const access = useAccess(file.id, framed);
  const parsed = useParsed(file.id, framed ? null : source ? 'text' : PARSED[format] ?? null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    root.current?.querySelector<HTMLElement>('.photo-viewer__close')?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; (returnTo.current as HTMLElement | null)?.focus?.(); };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    trapTab(event, root.current);
  };
  const state = framed ? (access === 'ready' ? 'ready' : access === 'denied' ? 'denied' : 'loading') : parsed.status;
  const quiet = (label: string, run: () => void) => <Button variant="link" onClick={run}>{label}</Button>;
  const notes: ReactNode[] = [];
  let body: ReactNode = null;
  if (state === 'denied') body = <p className="file-viewer__state" role="alert">You no longer have access to this file.</p>;
  else if (state === 'failed') body = <p className="file-viewer__state" role="alert">This file could not be shown. Download it to open it.</p>;
  else if (state === 'loading') body = <p className="file-viewer__state"><Spinner label={`Opening ${file.name}`} />{file.name}</p>;
  else if (format === 'html' && !source) {
    body = <HtmlPage file={file} scripts={scripts} />;
    notes.push(scripts ? 'Scripts are on for this preview. A script may contact the internet.'
      : <>External images and scripts are blocked. {quiet('Run scripts', () => setScripts(true))}</>);
  } else if (format === 'pdf') body = <PdfPage file={file} />;
  else if (parsed.status === 'ready') {
    const model = parsed.model;
    const label = `Contents of ${file.name}`;
    body = model.kind === 'json' ? <JsonView model={model} label={label} />
      : model.kind === 'json-error' ? <JsonErrorView model={model} label={label} />
        : model.kind === 'table' ? <TableView model={model} label={label} />
          : <TextView model={model} numbers={numbers} label={label} />;
    if (model.kind === 'table') notes.push(`${tableRows(model).toLocaleString('en-GB')} ${tableRows(model) === 1 ? 'row' : 'rows'}`);
    const hidden = model.kind === 'table' ? hiddenColumns(model) : null;
    if (hidden) notes.push(hidden);
    if (model.encoding === 'windows-1252') notes.push('Shown as Windows-1252 text.');
    if (model.kind === 'text') notes.push(quiet(numbers ? 'Hide line numbers' : 'Show line numbers', () => setNumbers((on) => !on)));
  }
  if (format === 'html' && state !== 'denied') notes.push(quiet(source ? 'Preview' : 'View source', () => { setSource((on) => !on); setScripts(false); }));
  return createPortal(
    <div ref={root} className="photo-viewer file-viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}
      data-theme-fixed="dark" data-preview-format={format}>
      <div className="photo-viewer__top">
        <button type="button" className="photo-viewer__round photo-viewer__close" onClick={onClose} aria-label="Close preview"><Icon name="x" size={18} /></button>
        <div className="photo-viewer__who"><strong id={titleId}>{file.name}</strong><span>{[fileWord(fileKind(file.name)), fileSize(file.size)].join(' · ')}</span></div>
        <span className="photo-viewer__spacer" aria-hidden="true" />
      </div>
      <div className="photo-viewer__stage"><div className={`file-viewer__sheet file-viewer__sheet--${format}`} data-state={state}>{body}</div></div>
      <div className="photo-viewer__caption"><small className="file-viewer__note" role="status">
        {notes.map((note, index) => <span key={index}>{index ? ' · ' : ''}{note}</span>)}</small></div>
      <div className="photo-viewer__actions" role="group" aria-label="File actions">
        <a href={filePath(file.id)} download={file.name}><Icon name="download" size={20} />Download</a>
      </div>
    </div>, document.body);
}
