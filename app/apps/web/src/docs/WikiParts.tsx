import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DocSummary } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Button, Icon, prefersReducedMotion, usePop, useToast } from '../ui';
import { useShellActions } from '../app/shellContext';
import { createDoc, docUrl, fetchProjectExport, listProjectDocs } from './api';
import { DeletePageDialog, type DeletablePage } from './DeletePage';
import { pageFileName, pageMarkdown, saveBlob } from './markdown-file';
import { landOn } from './WikiRead';
import { holdTyping } from './typeAhead';
import { ClientChanges } from '../assistant/ClientChanges';
import { useWiki } from './wiki-context';

// The Wiki page as drawn (#869, design guide "Wiki"): two columns only, the sidebar and the page. Above the title one
// quiet row: "Saved · just now · Jonas is here too", the faces of the people writing, Contents (≡) and ⋯. The title is the
// page switcher, in the same place with one page or fifty. The page's text is edited where it is read.

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Closes a surface on a press outside it (and its button). */
function useAway(open: boolean, close: () => void, ...inside: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!inside.some((ref) => ref.current?.contains(event.target as Node))) close(); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
    // The refs are stable; `close` is the caller's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Opens a clicked reference in the app: tasks and decisions in the Details panel, the rest by route. */
export function useReferenceClicks() {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  return (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const type = anchor.dataset.refType;
    const id = anchor.dataset.refId;
    if (id && (type === 'work' || type === 'decision')) {
      event.preventDefault();
      openDetails({ kind: type, id });
      return;
    }
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('/') && !href.startsWith('//')) {
      event.preventDefault();
      navigate(href);
    }
  };
}

/**
 * Scrolls the page so `top()` (the scroll position a heading needs) is reached, smoothly unless the person reduces
 * motion. Returns how to stop a landing still in progress.
 */
export function scrollPage(scroller: HTMLElement, top: () => number | null): () => void {
  const target = top();
  if (target === null) return () => undefined;
  const smooth = !prefersReducedMotion();
  scroller.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  return smooth ? landOn(scroller, top) : () => undefined;
}

export interface ContentsHeading { id: string; text: string; level: number }
export interface ShownPage { title: string; body: () => string; version: number; current: boolean }

export interface PageFrameProps {
  docId: string;
  title: string;
  /** "Saved · just now · Jonas is here too", or what an earlier version is. */
  meta: ReactNode;
  /** Attributes of the status line (the live editor names its state for tests and tools). */
  metaData?: Record<string, string | number | undefined>;
  faces?: ReactNode;
  headings: ContentsHeading[];
  onHeading(id: string): void;
  shown: ShownPage;
  /** Renames the page; absent on an earlier version. */
  rename?: (title: string) => Promise<void>;
  notices?: ReactNode;
  onBodyClick?: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}

/** The page as drawn: the row above the title, the title switcher, then the page itself. */
export function PageFrame({ docId, title, meta, metaData, faces, headings, onHeading, shown, rename, notices, onBodyClick, children }: PageFrameProps) {
  const { project, importError, importErrorId } = useWiki();
  const [renaming, setRenaming] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [deleting, setDeleting] = useState<DeletablePage | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const titleId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const base = docUrl(project.id, docId);
  const linkPath = shown.current ? base : `${base}/versions/${shown.version}`;
  return (
    <article className="wiki-page" aria-labelledby={titleId}>
      <div className="wiki-head">
        {/* Not a live region: "Saving…" and "Saved" are not announced at every pause (#950). The editor announces who joins. */}
        <p className="wiki-head__meta" {...metaData}>{meta}</p>
        {faces}
        <Contents headings={headings} onHeading={onHeading} />
        <PageMenu buttonRef={menuButton} historyTo={`${base}/history`} shown={shown} linkPath={linkPath}
          onRename={rename ? () => setRenaming(true) : undefined} onDelete={rename ? () => setDeleting({ id: docId, title, version: shown.version }) : undefined}
          onCopyFailed={() => setCopyFailed(true)} />
      </div>
      <div className="wiki-title">
        {renaming && rename
          ? <div className="wiki-title__h"><RenameField title={title} rename={rename} done={() => { setRenaming(false); menuButton.current?.focus(); }} /></div>
          : <PageSwitcher docId={docId} title={title} titleId={titleId} />}
      </div>
      {/* What a local client changed on this page, with its change line and Undo (#868, LC-2). */}
      {shown.current ? <ClientChanges key={docId} projectId={project.id} kind="doc" id={docId} refreshKey={shown.version} /> : null}
      {copyFailed ? <CopyFallback path={linkPath} close={() => { setCopyFailed(false); menuButton.current?.focus(); }} /> : null}
      <DeletePageDialog page={deleting} onClose={() => setDeleting(null)}
        onDeleted={(gone) => { setDeleting(null); toast({ message: `Deleted “${gone.title}”.`, tone: 'success' }); navigate(`/projects/${project.id}/docs`); }} />
      {importError ? <p className="doc-notice" id={importErrorId} role="alert"><Icon name="alert" size={14} />{importError}</p> : null}
      {notices}
      {/* The cards and chips in the page are links: a click opens what they refer to. */}
      <div className="wiki-body" onClick={onBodyClick}>{children}</div>
    </article>
  );
}

/** "Lending rules ▾": the space's pages with "Find a page", and "+ New page" at the bottom (#869). */
function PageSwitcher({ docId, title, titleId }: { docId: string; title: string; titleId: string }) {
  const { project, docs: loaded } = useWiki();
  const userId = useShellData().me.user.id;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The pages read when the switcher opened; until then (and after it closes) the Wiki's own list.
  const [fresh, setFresh] = useState<DocSummary[] | null>(null);
  const docs = fresh ?? loaded;
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const pop = usePop(open);
  const id = useId();
  const close = useCallback((restore = true) => { setOpen(false); setQuery(''); setFresh(null); if (restore) button.current?.focus(); }, []);
  useAway(open, () => close(false), surface, button);
  // The list as it is now: someone may have added a page since this one opened. A newer read replaces one still on its way.
  const reading = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    listProjectDocs(project.id, controller.signal).then((items) => { if (!controller.signal.aborted) setFresh(items); }, () => undefined);
  }, [project.id]);
  useEffect(() => {
    if (!open) return;
    findRef.current?.focus();
    read();
    return () => reading.current?.abort();
  }, [open, read]);
  // A page deleted while the list is open leaves it at once (#1021): the event names the space, so the list is read again.
  useStreamEvents(userId, (event) => { if (open && event.kind === 'project.doc_deleted.v1' && event.objectId === project.id) read(); });
  const pages = useMemo(() => [...docs].sort((a, b) => collator.compare(a.title, b.title)), [docs]);
  const needle = fold(query.trim());
  const shown = needle ? pages.filter((doc) => fold(doc.title).includes(needle)) : pages;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    const rows = [...(surface.current?.querySelectorAll<HTMLElement>('.wiki-menu__row') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); rows[(at + 1) % rows.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (at <= 0) findRef.current?.focus(); else rows[at - 1]?.focus(); }
  };
  return (
    <>
      <h2 className="wiki-title__h" id={titleId}>
        <button ref={button} type="button" className="wiki-switch" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => (open ? close() : setOpen(true))}>
          <span className="wiki-switch__t">{title}</span><Icon name="chevron-down" size={20} />
        </button>
      </h2>
      {pop.mounted ? (
        <div {...pop.props} ref={surface} id={id} className="wiki-menu wiki-switcher" role="dialog" aria-label={`Pages in ${project.name}`} onKeyDown={onKeyDown}>
          <label className="wiki-find">
            <Icon name="search" size={15} />
            <input ref={findRef} type="text" placeholder="Find a page" aria-label="Find a page" autoComplete="off" value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && shown[0]) { event.preventDefault(); close(false); navigate(docUrl(project.id, shown[0].id)); } }} />
          </label>
          <ul className="wiki-menu__list" aria-label="Pages">
            {shown.map((doc) => (
              <li key={doc.id}>
                <Link className="wiki-menu__row" to={docUrl(project.id, doc.id)} aria-current={doc.id === docId ? 'page' : undefined} title={doc.title}
                  onClick={() => close(false)}>
                  <span className="wiki-menu__t">{doc.title}</span>
                  {doc.id === docId ? <Icon name="check" size={15} /> : null}
                </Link>
              </li>
            ))}
          </ul>
          {needle && !shown.length ? <p className="wiki-menu__empty" role="status">No page matches “{query.trim()}”.</p> : null}
          <div className="wiki-menu__sep" />
          <NewPage name={query.trim()} done={() => close(false)} />
        </div>
      ) : null}
    </>
  );
}

/**
 * "New page": names the page in place, then opens it to write. A row of the switcher's menu by default; `primary` is the empty
 * Wiki's one primary Button (#1233, #1234), an ordinary button with no menu class, so nothing of it can stack over a window.
 */
export function NewPage({ name, done, primary }: { name?: string; done?: () => void; primary?: boolean }) {
  const { project } = useWiki();
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const intents = useIntentKeys();
  const navigate = useNavigate();
  const fieldId = useId();
  async function create(event: FormEvent) {
    event.preventDefault();
    const clean = title.trim();
    if (!clean || busy) return;
    // What is typed from now on is the new page's first text, kept until its editor is there (#1171).
    const release = holdTyping();
    setBusy(true); setError('');
    const intent = JSON.stringify(['new-page', project.id, clean]);
    try {
      const doc = await createDoc(project.id, { title: clean }, intents.keyFor(intent));
      intents.settle(intent);
      done?.();
      navigate(docUrl(project.id, doc.id), { state: { writeAt: 'start' } });
    } catch (cause) {
      release();
      setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this space but not add pages to it.' : 'The page was not created. Check the connection and try again.');
    } finally { setBusy(false); }
  }
  if (!naming) {
    if (primary) return <Button variant="primary" icon="plus" onClick={() => { setTitle(name ?? ''); setNaming(true); }}>New page</Button>;
    return (
      <button type="button" className="wiki-menu__row wiki-menu__new" onClick={() => { setTitle(name ?? ''); setNaming(true); }}>
        <Icon name="plus" size={15} />New page
      </button>
    );
  }
  return (
    <form className="wiki-newpage" onSubmit={(event) => void create(event)}>
      <label className="ui-vh" htmlFor={fieldId}>Name of the new page</label>
      <input id={fieldId} className="wiki-newpage__field" value={title} placeholder="Name of the new page" maxLength={200} autoFocus autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNaming(false); } }} />
      <Button type="submit" variant={primary ? 'primary' : 'soft'} disabled={!title.trim()} busy={busy}>Create</Button>
      {error ? <p className="wiki-menu__error" role="alert">{error}</p> : null}
    </form>
  );
}

/** The title as a field, in the title's place: Enter keeps the new name, Escape the old one. */
function RenameField({ title, rename, done }: { title: string; rename: (title: string) => Promise<void>; done: () => void }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  async function keep() {
    const clean = value.trim();
    if (busy) return;
    if (!clean || clean === title) { done(); return; }
    setBusy(true); setError('');
    try { await rename(clean); done(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? `The page was not renamed: ${cause.message.replace(/\.$/, '')}.` : 'The page was not renamed. Try again.'); }
    finally { setBusy(false); }
  }
  return (
    <span className="wiki-rename">
      <input ref={ref} className="wiki-rename__field" aria-label="Page title" value={value} maxLength={200} disabled={busy}
        onChange={(event) => setValue(event.target.value)} onBlur={() => void keep()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void keep(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(); }
        }} />
      {error ? <span className="wiki-rename__error" role="alert">{error}</span> : null}
    </span>
  );
}

/** Contents (≡): the page's headings; choosing one scrolls to it. Always in the same place; "No headings yet" without any. */
function Contents({ headings, onHeading }: { headings: ContentsHeading[]; onHeading(id: string): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const pop = usePop(open);
  const id = useId();
  const close = useCallback((restore = true) => { setOpen(false); if (restore) button.current?.focus(); }, []);
  useAway(open, () => close(false), surface, button);
  useEffect(() => { if (open) (surface.current?.querySelector<HTMLElement>('[role="menuitem"]') ?? surface.current)?.focus(); }, [open]);
  const base = headings.length ? Math.min(...headings.map((heading) => heading.level)) : 1;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => menuKeys(event, surface.current, close);
  return (
    <span className="wiki-pop-anchor">
      <button ref={button} type="button" className="ui-icon-btn wiki-head__btn" aria-label="Contents" data-tip={open ? undefined : 'Contents'}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => (open ? close() : setOpen(true))}>
        <ContentsIcon />
      </button>
      {pop.mounted ? (
        <div {...pop.props} ref={surface} id={id} className="wiki-menu wiki-menu--end wiki-contents" role="menu" aria-label="Contents" tabIndex={-1} onKeyDown={onKeyDown}>
          {headings.length ? headings.map((heading) => (
            <button key={heading.id} type="button" role="menuitem" className="wiki-menu__row" data-level={heading.level - base}
              onClick={() => { close(); onHeading(heading.id); }}>
              <span className="wiki-menu__t">{heading.text}</span>
            </button>
          )) : <p className="wiki-menu__empty">No headings yet</p>}
        </div>
      ) : null}
    </span>
  );
}

function ContentsIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M5 7h14M5 12h10M5 17h12" /></svg>;
}

/** Up and Down move through a menu's rows, Escape closes it and gives focus back. */
function menuKeys(event: KeyboardEvent<HTMLElement>, surface: HTMLElement | null, close: (restore?: boolean) => void) {
  const rows = [...(surface?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); rows[(at + 1) % rows.length]?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); rows[(at - 1 + rows.length) % rows.length]?.focus(); }
  else if (event.key === 'Tab') close(false);
}

/** ⋯ Page actions: History, Copy link, Export, Import a Markdown file, and Rename page and Delete page for the current page. */
function PageMenu({ buttonRef, historyTo, shown, linkPath, onRename, onDelete, onCopyFailed }: {
  buttonRef: React.RefObject<HTMLButtonElement | null>; historyTo: string; shown: ShownPage; linkPath: string; onRename?: () => void; onDelete?: () => void; onCopyFailed(): void;
}) {
  const { project, importing, importErrorId, importError, startImport } = useWiki();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const pop = usePop(open);
  const id = useId();
  const close = useCallback((restore = true) => { setOpen(false); setExporting(false); if (restore) buttonRef.current?.focus(); }, [buttonRef]);
  useAway(open, () => close(false), surface, buttonRef);
  useEffect(() => { if (open) surface.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [open, exporting]);
  const fileName = pageFileName(shown.title, shown.current ? undefined : shown.version);
  const page = () => {
    saveBlob(new Blob([pageMarkdown(shown.title, shown.body())], { type: 'text/markdown;charset=utf-8' }), fileName);
    close();
    toast({ message: `Downloaded ${fileName}.`, tone: 'success' });
  };
  async function wholeSpace() {
    if (busy) return;
    setBusy(true);
    try {
      const file = await fetchProjectExport(project.id);
      saveBlob(file.blob, file.fileName);
      close();
      toast({ message: `Exported ${project.name} as ${file.fileName}.`, tone: 'success' });
    } catch (cause) {
      close();
      toast({ message: cause instanceof ApiError && cause.status === 403 ? 'Only people who manage this space can export the whole space.' : 'The export could not be made. Check the connection and try again.' });
    } finally { setBusy(false); }
  }
  async function copy() {
    close();
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${linkPath}`);
      toast({ message: 'Link copied.', tone: 'success' });
    } catch { onCopyFailed(); }
  }
  return (
    <span className="wiki-pop-anchor">
      <button ref={buttonRef} type="button" className="ui-icon-btn wiki-head__btn" aria-label="Page actions" data-tip={open ? undefined : 'Page actions'}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="more" size={16} />
      </button>
      {pop.mounted ? (
        <div {...pop.props} ref={surface} id={id} className="wiki-menu wiki-menu--end wiki-actions" role="menu" aria-label="Page actions"
          onKeyDown={(event) => menuKeys(event, surface.current, close)}>
          {exporting ? <>
            <MenuRow label={shown.current ? 'This page as Markdown' : `Version ${shown.version} as Markdown`} run={page} />
            <MenuRow label={busy ? 'Exporting the whole space…' : 'The whole space as .tar.gz'} run={() => void wholeSpace()} busy={busy} />
          </> : <>
            <MenuRow label="History" run={() => { close(false); navigate(historyTo); }} />
            <MenuRow label="Copy link" run={() => void copy()} />
            {/* People who manage the space can also take the whole space; everyone else gets this page at once. */}
            <MenuRow label="Export" run={() => (project.access === 'manager' ? setExporting(true) : page())} more={project.access === 'manager'} />
            <MenuRow label={importing ? 'Importing…' : 'Import a Markdown file'} run={() => { close(); startImport(); }} busy={importing}
              describedBy={importError ? importErrorId : undefined} />
            {onRename ? <MenuRow label="Rename page" run={() => { close(false); onRename(); }} /> : null}
            {/* The menu closes onto its button first, so the dialog gives focus back to it. */}
            {onDelete ? <MenuRow label="Delete page" run={() => { close(); onDelete(); }} /> : null}
          </>}
        </div>
      ) : null}
    </span>
  );
}

function MenuRow({ label, run, busy, more, describedBy }: { label: string; run(): void; busy?: boolean; more?: boolean; describedBy?: string }) {
  return (
    <button type="button" role="menuitem" className="wiki-menu__row" onClick={run} aria-busy={busy || undefined} aria-haspopup={more ? 'menu' : undefined}
      aria-describedby={describedBy}><span className="wiki-menu__t">{label}</span></button>
  );
}

/** The browser refused the clipboard: the exact link, selected, to copy by hand. */
function CopyFallback({ path, close }: { path: string; close(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="doc-notice wiki-copy" role="group" aria-label="Link to this page">
      <label className="ui-vh" htmlFor={fieldId}>Link to this page</label>
      <input id={fieldId} ref={ref} className="ui-input wiki-copy__field" readOnly value={`${window.location.origin}${path}`}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }} />
      <span role="status">The browser did not allow copying. The link is selected: press {isMac ? '⌘ C' : 'Ctrl C'}.</span>
      <button type="button" className="ui-btn ui-btn--quiet" onClick={close}>Done</button>
    </div>
  );
}

/** The people writing on the page with you, as faces (the shape that marks their caret, then initials). */
export function Faces({ people }: { people: { id: string; name: string }[] }) {
  if (!people.length) return null;
  return (
    <span className="wiki-head__faces" aria-label={`Writing here: ${people.map((person) => person.name).join(', ')}`} role="img">
      {people.slice(0, 3).map((person) => <span key={person.id} className="wiki-face" aria-hidden="true">{initialsOf(person.name)}</span>)}
    </span>
  );
}
function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)![0] ?? '' : '')).toUpperCase();
}

/** "Jonas is here too", "Jonas and Maja are here too", "Jonas and 2 others are here too". */
export function hereToo(people: { name: string }[]): string {
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  if (!people.length) return '';
  if (people.length === 1) return `${first(people[0]!.name)} is here too`;
  if (people.length === 2) return `${first(people[0]!.name)} and ${first(people[1]!.name)} are here too`;
  return `${first(people[0]!.name)} and ${people.length - 1} others are here too`;
}

/** The wiki of a space with no pages yet: start one, or import a Markdown file. */
export function NoPages() {
  const { project, importing, importError, importErrorId, startImport } = useWiki();
  return (
    <div className="wiki-page wiki-empty">
      <h2 className="wiki-empty__t">No pages yet</h2>
      <p className="doc-muted">Write down how things work in {project.name} and what you learned. Every change keeps the earlier version.</p>
      <div className="wiki-empty__acts">
        <NewPage primary />
        <Button variant="outline" onClick={startImport} busy={importing} aria-describedby={importError ? importErrorId : undefined}>Import a Markdown file</Button>
      </div>
      {importError ? <p className="doc-notice" id={importErrorId} role="alert"><Icon name="alert" size={14} />{importError}</p> : null}
    </div>
  );
}

/** Time words that stay true while the page stays open. */
export function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), every); return () => window.clearInterval(timer); }, [every]);
  return now;
}
