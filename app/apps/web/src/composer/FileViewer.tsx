import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { filePath, filePreviewPath, type MessageFile } from '@flux/contracts';
import { send } from '../api/client';
import { Button, Icon, Spinner, trapTab } from '../ui';
import { fileKind, fileSize, fileWord, type PreviewFormat } from './fileKind';

// A file preview in the photo viewer's frame (C-58, #1252, F-026 §6): always dark, Close, the name with "type · size", Download.
// Someone else's HTML never runs on Flux's origin: it is framed from the preview route, which sandboxes it to an opaque origin
// and lets it fetch nothing; the frame's own `sandbox` attribute says the same.

/** No feature a page could ask the browser for: Flux may hold the camera and microphone for a call, the preview never does. */
const NOTHING_ALLOWED = "camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; clipboard-read 'none'; clipboard-write 'none'";

type Access = 'checking' | 'ready' | 'denied';

/**
 * The reader's access to the file, asked again on every open with the download's own check (a HEAD of the download: no bytes travel),
 * so a person who lost access sees that, not a framed error. The frame's own read is checked again by the preview route.
 */
function useAccess(fileId: string): Access {
  const [state, setState] = useState<{ id: string; access: Access }>({ id: '', access: 'checking' });
  useEffect(() => {
    const controller = new AbortController();
    send(filePath(fileId), { method: 'HEAD', leavesReads: true, cache: 'no-store', signal: controller.signal })
      .then((response) => setState({ id: fileId, access: response.ok ? 'ready' : 'denied' }))
      .catch(() => { if (!controller.signal.aborted) setState({ id: fileId, access: 'denied' }); });
    return () => controller.abort();
  }, [fileId]);
  return state.id === fileId ? state.access : 'checking';
}

/** The HTML page as its author wrote it, in a sandboxed frame; scripts run only after the person's Run scripts, for this preview. */
function HtmlPage({ file, scripts }: { file: MessageFile; scripts: boolean }) {
  return <iframe key={scripts ? 'scripts' : 'still'} className="file-viewer__frame" title={`Preview of ${file.name}`}
    src={filePreviewPath(file.id, scripts)} sandbox={scripts ? 'allow-scripts' : ''} allow={NOTHING_ALLOWED} referrerPolicy="no-referrer" />;
}

export function FileViewer({ file, format, onClose }: { file: MessageFile; format: PreviewFormat; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<Element | null>(null);
  const access = useAccess(file.id);
  const [scripts, setScripts] = useState(false);
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
  let body: ReactNode;
  let note: ReactNode = null;
  if (access === 'denied') body = <p className="file-viewer__state" role="alert">You no longer have access to this file.</p>;
  else if (access === 'checking') body = <p className="file-viewer__state"><Spinner label={`Opening ${file.name}`} />{file.name}</p>;
  else {
    body = format === 'html' ? <HtmlPage file={file} scripts={scripts} /> : null;
    if (format === 'html') {
      note = scripts
        ? <>Scripts are on for this preview. A script may contact the internet.</>
        : <>External images and scripts are blocked. <Button variant="link" onClick={() => setScripts(true)}>Run scripts</Button></>;
    }
  }
  return createPortal(
    <div ref={root} className="photo-viewer file-viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}
      data-theme-fixed="dark" data-preview-format={format}>
      <div className="photo-viewer__top">
        <button type="button" className="photo-viewer__round photo-viewer__close" onClick={onClose} aria-label="Close preview"><Icon name="x" size={18} /></button>
        <div className="photo-viewer__who"><strong id={titleId}>{file.name}</strong><span>{[fileWord(fileKind(file.name)), fileSize(file.size)].join(' · ')}</span></div>
        <span className="photo-viewer__spacer" aria-hidden="true" />
      </div>
      <div className="photo-viewer__stage"><div className={`file-viewer__sheet file-viewer__sheet--${format}`} data-access={access}>{body}</div></div>
      <div className="photo-viewer__caption"><small className="file-viewer__note" role="status">{note}</small></div>
      <div className="photo-viewer__actions" role="group" aria-label="File actions">
        <a href={filePath(file.id)} download={file.name}><Icon name="download" size={20} />Download</a>
      </div>
    </div>, document.body);
}
