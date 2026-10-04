import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { Button, Icon, Spinner, duration, play, trapTab, useToast } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { audienceLine, useProjectShell } from '../project/data';
import { fetchProjectExport } from './api';
import { pageFileName, pageMarkdown, saveBlob } from './markdown-file';
import { useWiki } from './wiki-context';

// The wiki's top bar (#136, Studio 11.6): focus, history, share and download as quiet icon
// buttons, then the one primary action. Share and Download open small popovers that keep focus
// inside, close on Escape or outside, and return focus to their button.

/** Wiki-only icons, drawn like ../ui/Icon: 16×16, a 1.5px stroke. */
const PATHS = {
  expand: <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />,
  shrink: <path d="M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25" />,
  history: <><path d="M3.1 5.75A5.25 5.25 0 1 1 2.75 8" /><path d="M2.75 2.75v3h3" /><path d="M8 5.25V8l2 1.5" /></>,
  share: <><path d="M13.5 2.5L7 9" /><path d="M13.5 2.5l-4 11-2.5-4.5-4.5-2.5z" /></>,
  download: <><path d="M8 2.75v7.5M4.75 7L8 10.25 11.25 7" /><path d="M2.75 11.25v1.5a.5.5 0 00.5.5h9.5a.5.5 0 00.5-.5v-1.5" /></>,
  upload: <><path d="M8 10.25v-7.5M4.75 6L8 2.75 11.25 6" /><path d="M2.75 11.25v1.5a.5.5 0 00.5.5h9.5a.5.5 0 00.5-.5v-1.5" /></>,
  archive: <><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6.25a.75.75 0 00.75.75h7.5a.75.75 0 00.75-.75V6M6.5 8.75h3" /></>,
};
export type WikiIconName = keyof typeof PATHS;

export function WikiIcon({ name, size = 16 }: { name: WikiIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** The 57px bar above every wiki document: what is shown on the left, actions on the right. */
export function WikiBar({ meta, children }: { meta: ReactNode; children?: ReactNode }) {
  return (
    <div className="wiki-bar">
      <div className="wiki-bar__meta">{meta}</div>
      <div className="wiki-bar__acts"><FocusToggle />{children}</div>
    </div>
  );
}

function FocusToggle() {
  const { focus, setFocus } = useWiki();
  return (
    <button type="button" className="ui-icon-btn wiki-bar__focus" aria-pressed={focus} aria-label="Focus on the page"
      data-tip={focus ? 'Show the page list' : 'Focus on the page'} onClick={() => setFocus(!focus)}>
      <WikiIcon name={focus ? 'shrink' : 'expand'} />
    </button>
  );
}

/** Closes the open popover; with `restore`, focus returns to its button. */
const ClosePopover = createContext<(restore?: boolean) => void>(() => undefined);

function Popover({ icon, label, title, children }: { icon: WikiIconName; label: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    void play(pop, [{ opacity: 0 }, { opacity: 1 }], duration('--dur-1'), '--ease-out', { fill: 'backwards' });
    (pop?.querySelector<HTMLElement>('[data-autofocus]') ?? pop)?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!pop?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    trapTab(event, popRef.current);
  };

  return (
    <div className="wiki-pop-wrap">
      <button ref={buttonRef} type="button" className="ui-icon-btn" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined} data-tip={open ? undefined : label} onClick={() => setOpen((value) => !value)}>
        <WikiIcon name={icon} />
      </button>
      {open ? <div ref={popRef} id={id} className="wiki-pop" role="dialog" aria-label={title} tabIndex={-1} onKeyDown={onKeyDown}><ClosePopover.Provider value={close}>{children}</ClosePopover.Provider></div> : null}
    </div>
  );
}

/** A link to the page (or the earlier version on screen), with exactly who can open it. */
export function ShareButton({ path, version }: { path: string; version: number | null }) {
  return <Popover icon="share" label="Share this page" title="Share this page"><ShareBody path={path} version={version} /></Popover>;
}

function ShareBody({ path, version }: { path: string; version: number | null }) {
  const close = useContext(ClosePopover);
  const { project } = useWiki();
  const shell = useProjectShell();
  const { me } = useShellData();
  const { openDetails } = useShellActions();
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const people = shell && shell.project.id === project.id ? shell.people : null;
  const url = `${window.location.origin}${path}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('yes');
    } catch {
      setCopied('no');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  return (
    <>
      <p className="wiki-pop__h">{version ? `Share version ${version}` : 'Share this page'}</p>
      <p className="wiki-pop__who"><Icon name="lock" size={12} />
        <span>Opens only for people with access to {project.name}{people ? <>: {audienceLine(people, me.user.id)}</> : null}.</span></p>
      <div className="wiki-pop__link">
        <label className="ui-vh" htmlFor={inputId}>Link to this page</label>
        <input id={inputId} ref={inputRef} className="ui-input" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        <Button variant="secondary" icon={copied === 'yes' ? 'check' : 'link'} onClick={() => void copy()} data-autofocus>{copied === 'yes' ? 'Copied' : 'Copy link'}</Button>
      </div>
      <p className="wiki-pop__status" role="status">{copied === 'yes' ? 'Link copied.' : copied === 'no' ? `The browser did not allow copying. The link is selected: press ${isMac ? '⌘ C' : 'Ctrl C'}.` : ''}</p>
      <Button variant="link" className="wiki-pop__more" onClick={() => { close(false); openDetails('place'); }}>See who has access</Button>
    </>
  );
}

interface Shown { title: string; body: string; version: number; current: boolean }

/** This page (or version) as Markdown for everyone who can read it; the whole project for managers. */
export function DownloadButton({ shown }: { shown: Shown }) {
  return <Popover icon="download" label="Download" title="Download"><DownloadBody shown={shown} /></Popover>;
}

function DownloadBody({ shown }: { shown: Shown }) {
  const close = useContext(ClosePopover);
  const { project } = useWiki();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileName = pageFileName(shown.title, shown.current ? undefined : shown.version);

  function page() {
    saveBlob(new Blob([pageMarkdown(shown.title, shown.body)], { type: 'text/markdown;charset=utf-8' }), fileName);
    close();
    toast({ message: `Downloaded ${fileName}.`, tone: 'success' });
  }

  async function wholeProject() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const file = await fetchProjectExport(project.id);
      saveBlob(file.blob, file.fileName);
      close();
      toast({ message: `Exported ${project.name} as ${file.fileName}.`, tone: 'success' });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? 'Only people who manage this space can export the whole project.'
        : cause instanceof ApiError && cause.status === 404 ? 'This project is no longer available to you.'
          : 'The export could not be made. Check the connection and try again.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <p className="wiki-pop__h">Download</p>
      <button type="button" className="wiki-pop__item" onClick={page} data-autofocus>
        <Icon name="doc" />
        <span><b>{shown.current ? 'This page as Markdown' : `Version ${shown.version} as Markdown`}</b><small>{fileName}</small></span>
      </button>
      {project.access === 'manager' ? (
        <button type="button" className="wiki-pop__item" onClick={() => void wholeProject()} aria-busy={busy || undefined} aria-disabled={busy || undefined}>
          {busy ? <Spinner /> : <WikiIcon name="archive" />}
          <span><b>Export the whole project</b><small>A .tar.gz of every page, conversation, task and map, for people who manage {project.name}</small></span>
        </button>
      ) : <p className="wiki-pop__note">People who manage this space can also export the whole project.</p>}
      {error ? <p className="wiki-pop__error" role="alert">{error}</p> : null}
    </>
  );
}
