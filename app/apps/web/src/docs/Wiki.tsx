import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, Outlet, redirect, useLoaderData, useMatch, useNavigate, useParams, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { DocSummary, Project } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Icon, Spinner, useToast } from '../ui';
import { getProject } from '../app/conversation-api';
import { createDoc, docUrl, listProjectDocs } from './api';
import { readMarkdownFile } from './markdown-file';
import { WikiIcon } from './WikiParts';
import { WikiContext, useWiki, type WikiState } from './wiki-context';
import './docs.css';

// The project wiki as two panes (#136, Studio 11.6 / UI116-4): a page index with search, New page
// and Import .md beside the document. The open page is marked by a quiet tint, a stronger label,
// a small dot and aria-current, never by colour alone. In a narrow work area the index becomes a
// compact strip above the document.

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
  const [focus, setFocusState] = useState(() => readKey(FOCUS_KEY) === '1');
  useEffect(() => { if (docId) writeKey(pageKey(project.id), docId); }, [project.id, docId]);
  const value = useMemo<WikiState>(() => ({
    project, docs, focus, writable: project.access !== 'viewer',
    setFocus(next: boolean) { writeKey(FOCUS_KEY, next ? '1' : null); setFocusState(next); },
  }), [project, docs, focus]);
  return (
    <WikiContext.Provider value={value}>
      <div className="wiki-frame">
        <div className={`wiki${focus ? ' wiki--focus' : ''}`}>
          <WikiIndex activeId={docId ?? null} hidden={focus} />
          <div className="wiki-main pane-scroll"><Outlet /></div>
        </div>
      </div>
    </WikiContext.Provider>
  );
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

function WikiIndex({ activeId, hidden }: { activeId: string | null; hidden: boolean }) {
  const { project, docs, writable } = useWiki();
  const navigate = useNavigate();
  const toast = useToast();
  const creating = !!useMatch('/projects/:projectId/docs/new');
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchId = useId();
  const errorId = useId();
  // A stable order to find a page by name; the server's order changes with every save.
  const pages = useMemo(() => [...docs].sort((a, b) => collator.compare(a.title, b.title)), [docs]);
  const needle = fold(query.trim());
  const shown = needle ? pages.filter((doc) => fold(`${doc.title} ${doc.excerpt}`).includes(needle)) : pages;

  // As a strip (narrow work area) the index scrolls sideways; keep the open page in view.
  useEffect(() => {
    const list = listRef.current;
    const link = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !link || list.scrollWidth <= list.clientWidth) return;
    const box = list.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.left < box.left || item.right > box.right) list.scrollLeft += item.left - box.left - 16;
  }, [activeId, hidden]);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setError('');
    setImporting(true);
    try {
      const read = await readMarkdownFile(file);
      if (!read.ok) { setError(read.error); return; }
      const doc = await createDoc(project.id, { title: read.title, body: read.body, state: 'draft', reason: `Imported from ${file.name}` }, crypto.randomUUID());
      toast({ message: `Imported “${doc.title}” as a draft page.`, tone: 'success' });
      navigate(docUrl(project.id, doc.id));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not add pages to it.'
        : cause instanceof ApiError ? `“${file.name}” was not imported: ${cause.message}.`
          : `“${file.name}” was not imported. Check the connection and try again.`);
    } finally { setImporting(false); }
  }

  return (
    <nav className="wiki-index" aria-label="Wiki pages" hidden={hidden}>
      <p className="wiki-index__eyebrow">Project memory</p>
      {docs.length ? (
        <div className="wiki-search">
          <Icon name="search" size={14} />
          <label className="ui-vh" htmlFor={searchId}>Search the wiki</label>
          <input id={searchId} type="search" placeholder="Search the wiki" autoComplete="off" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
        </div>
      ) : null}
      {needle ? <p className="wiki-index__count" role="status">{shown.length ? `${shown.length} ${shown.length === 1 ? 'page' : 'pages'}` : `No pages match “${query.trim()}”.`}</p> : null}
      {shown.length ? (
        <ul ref={listRef} className="wiki-pages">
          {shown.map((doc) => (
            <li key={doc.id}>
              <Link className="wiki-page" to={docUrl(project.id, doc.id)} aria-current={doc.id === activeId ? 'page' : undefined}>
                <Icon name="doc" size={12} />
                <span className="wiki-page__t">{doc.title}</span>
                {doc.state === 'draft' ? <span className="wiki-page__state">Draft</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {writable ? (
        <div className="wiki-index__acts">
          <Link className="ui-btn ui-btn--quiet wiki-index__act" to={`/projects/${project.id}/docs/new`} aria-current={creating ? 'page' : undefined}>
            <Icon name="plus" size={14} /><span className="wiki-index__act-t">New page</span>
          </Link>
          <button type="button" className="ui-btn ui-btn--quiet wiki-index__act" onClick={() => fileRef.current?.click()}
            aria-busy={importing || undefined} aria-describedby={error ? errorId : undefined}>
            {importing ? <Spinner /> : <WikiIcon name="upload" size={14} />}<span className="wiki-index__act-t">Import .md</span>
          </button>
          <input ref={fileRef} type="file" accept=".md,.markdown,text/markdown,text/x-markdown" hidden tabIndex={-1}
            onChange={(event) => void importFile(event)} />
        </div>
      ) : null}
      {error ? <p className="wiki-index__error" id={errorId} role="alert"><Icon name="alert" size={13} /><span>{error}</span></p> : null}
    </nav>
  );
}
