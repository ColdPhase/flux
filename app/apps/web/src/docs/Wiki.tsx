import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, Outlet, redirect, useLoaderData, useLocation, useMatch, useNavigate, useParams, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { DocSummary, Project } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useIntentKeys } from '../api/intent-keys';
import { Icon, Spinner, useToast } from '../ui';
import { getProject } from '../app/conversation-api';
import { createDoc, docUrl, listProjectDocs } from './api';
import { readMarkdownFile } from './markdown-file';
import { WikiIcon } from './WikiParts';
import { WikiContext, useWiki, type WikiState } from './wiki-context';
import './docs.css';

// The project wiki as drawn (F-026, #354): the "Pages" list beside the document. The open page is a
// raised row with a stronger label and aria-current, never colour alone. In a narrow work area
// (a phone) the list becomes a row of chips above the document and the page's actions one menu.

/** Below this width of the wiki itself it is "compact": the phone layout, whatever the viewport. */
const COMPACT_BELOW = 500;

interface WikiData { project: Project; docs: DocSummary[] }

const pageKey = (projectId: string) => `flux.project-wiki.${projectId}`;
const FOCUS_KEY = 'flux.wiki-focus';

function readKey(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string | null) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* private mode */ }
}

export async function wikiLoader({ params, request }: LoaderFunctionArgs): Promise<WikiData> {
  const [project, docs] = await Promise.all([getProject(params.projectId!, request.signal), listProjectDocs(params.projectId!, request.signal)]);
  // The Wiki tab opens a page: the one last open here in this tab, else the latest change.
  if (docs.length && new URL(request.url).pathname.replace(/\/+$/, '') === `/projects/${params.projectId}/docs`) {
    const remembered = readKey(pageKey(project.id));
    throw redirect(docUrl(project.id, (docs.find((doc) => doc.id === remembered) ?? docs[0]!).id));
  }
  return { project, docs };
}

/** The index follows every move inside the wiki (a saved, new or imported page), not a comparison change. */
export function wikiShouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname !== nextUrl.pathname) return true;
  if (currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

export function WikiLayout() {
  const { project, docs } = useLoaderData() as WikiData;
  const { docId } = useParams();
  // Writing gets the whole column on a phone: the page strip steps aside while a page is edited.
  const editing = /\/docs\/(new|[^/]+\/edit)$/.test(useLocation().pathname);
  const [focus, setFocusState] = useState(() => readKey(FOCUS_KEY) === '1');
  const frame = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setCompact(node.clientWidth < COMPACT_BELOW);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (docId) writeKey(pageKey(project.id), docId); }, [project.id, docId]);
  // Focus is a computer setting: on a phone the pages are always a row of chips (nothing to exit),
  // and the choice returns when the wiki is wide again.
  const value = useMemo<WikiState>(() => ({
    project, docs, focus, compact, writable: project.access !== 'viewer',
    setFocus(next: boolean) { writeKey(FOCUS_KEY, next ? '1' : null); setFocusState(next); },
  }), [project, docs, focus, compact]);
  return (
    <WikiContext.Provider value={value}>
      <div className="wiki-frame" ref={frame}>
        <div className={`wiki${focus && !compact ? ' wiki--focus' : ''}${editing ? ' wiki--editing' : ''}`}>
          <WikiIndex activeId={docId ?? null} hidden={focus && !compact} />
          <div className="wiki-main pane-scroll"><Outlet /></div>
        </div>
      </div>
    </WikiContext.Provider>
  );
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

function WikiIndex({ activeId, hidden }: { activeId: string | null; hidden: boolean }) {
  const { project, docs, writable, compact } = useWiki();
  const navigate = useNavigate();
  const toast = useToast();
  const creating = !!useMatch('/projects/:projectId/docs/new');
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const intents = useIntentKeys();
  const [error, setError] = useState('');
  // A refused import is about that attempt: opening another page clears it.
  const [errorFor, setErrorFor] = useState(activeId);
  if (errorFor !== activeId) { setErrorFor(activeId); if (error) setError(''); }
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchId = useId();
  const errorId = useId();
  // A stable order to find a page by name; the server's order changes with every save.
  const pages = useMemo(() => [...docs].sort((a, b) => collator.compare(a.title, b.title)), [docs]);
  const needle = fold(query.trim());
  const shown = needle ? pages.filter((doc) => fold(`${doc.title} ${doc.excerpt}`).includes(needle)) : pages;
  const listed = shown.length > 0;
  // On a phone the search appears once the chip row is long enough to need it (or while searching).
  const searchable = docs.length > 0 && (!compact || docs.length > 5 || !!query);

  // As a strip (narrow work area) the index scrolls sideways; keep the open page in view, also
  // when the strip's width changes (rotation, resize, a panel opening).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const link = list.querySelector<HTMLElement>('[aria-current="page"]');
      if (!link || list.scrollWidth <= list.clientWidth) return;
      const box = list.getBoundingClientRect();
      const item = link.getBoundingClientRect();
      if (item.left < box.left || item.right > box.right) list.scrollLeft += item.left - box.left - 16;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, hidden, listed]);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setError('');
    setImporting(true);
    try {
      const read = await readMarkdownFile(file);
      if (!read.ok) { setError(read.error); return; }
      // The same file chosen again after a lost answer reuses its key (#178): one page, never two.
      const intent = JSON.stringify(['import', project.id, file.name, read.title, read.body]);
      const doc = await createDoc(project.id, { title: read.title, body: read.body, state: 'draft', reason: `Imported from ${file.name}` }, intents.keyFor(intent));
      intents.settle(intent);
      toast({ message: `Imported “${doc.title}” as a draft page.`, tone: 'success' });
      navigate(docUrl(project.id, doc.id));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not add pages to it.'
        : cause instanceof ApiError ? `“${file.name}” was not imported: ${cause.message.replace(/\.$/, '')}.`
          : `“${file.name}” was not imported. Check the connection and try again.`);
    } finally { setImporting(false); }
  }

  const newPage = writable ? (
    <Link className="ui-icon-btn wiki-index__new" to={`/projects/${project.id}/docs/new`} aria-label="New page" aria-current={creating ? 'page' : undefined}>
      <Icon name="plus" size={16} />
    </Link>
  ) : null;
  const importer = writable ? (
    <>
      <button type="button" className={compact ? 'ui-icon-btn wiki-index__new' : 'ui-btn ui-btn--quiet wiki-index__import'} aria-label="Import .md" onClick={() => { if (!importing) fileRef.current?.click(); }}
        aria-disabled={importing || undefined} aria-busy={importing || undefined} aria-describedby={error ? errorId : undefined}>
        {importing ? <Spinner /> : <WikiIcon name="upload" size={14} />}{compact ? null : <span>Import .md</span>}
      </button>
      <input ref={fileRef} type="file" accept=".md,.markdown,text/markdown,text/x-markdown" hidden tabIndex={-1}
        onChange={(event) => void importFile(event)} />
    </>
  ) : null;

  return (
    <nav className="wiki-index" aria-label="Wiki pages" hidden={hidden}>
      {compact ? null : (
        <div className="wiki-index__head">
          <p className="wiki-index__eyebrow">Pages</p>
          {newPage}
        </div>
      )}
      {searchable ? (
        <div className="wiki-search">
          <Icon name="search" size={14} />
          <label className="ui-vh" htmlFor={searchId}>Search the wiki</label>
          <input id={searchId} type="search" placeholder="Search pages" autoComplete="off" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
        </div>
      ) : null}
      {/* Mounted while the index is shown, so a changed count is announced. */}
      <p className="wiki-index__count" role="status">{needle ? (shown.length ? `${shown.length} ${shown.length === 1 ? 'page' : 'pages'}` : `No pages match “${query.trim()}”.`) : ''}</p>
      {shown.length || compact ? (
        <ul ref={listRef} className="wiki-pages">
          {shown.map((doc) => (
            <li key={doc.id}>
              <Link className="wiki-page" to={docUrl(project.id, doc.id)} title={doc.title} aria-current={doc.id === activeId ? 'page' : undefined}>
                <span className="wiki-page__t">{doc.title}</span>
                {doc.state === 'draft' ? <span className="wiki-page__state">Draft</span> : null}
              </Link>
            </li>
          ))}
          {compact && writable ? <li className="wiki-pages__end">{newPage}{importer}</li> : null}
        </ul>
      ) : null}
      {!compact && writable ? <div className="wiki-index__acts">{importer}</div> : null}
      {error ? <p className="wiki-index__error" id={errorId} role="alert"><Icon name="alert" size={13} /><span>{error}</span></p> : null}
    </nav>
  );
}
