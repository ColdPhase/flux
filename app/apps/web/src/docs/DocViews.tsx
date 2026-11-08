import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { unlessLocked } from '../encryption/api';
import { Link, redirect, useLoaderData, useNavigate, useSearchParams, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { Doc, DocSummary, DocVersion, DocVersionSummary, LiveDocBootstrap } from '@flux/contracts';
import { ApiError } from '../api/client';
import { EmptyState, Icon, Select, Option } from '../ui';
import { useShellData } from '../app/data';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { docUrl, getDoc, getLiveDoc, getVersion, listVersions, listWorkspaceDocs } from './api';
import { diffDocs, diffStats, readableRefs, type DiffRow } from './diff';
import { authorLabel, longDate, shortDate } from './format';
import { DocProse } from './DocProse';
import { NoPages, PageFrame, scrollPage, useReferenceClicks } from './WikiParts';
import { useProse } from './WikiRead';
import { blockDiff } from './block-diff';
import { useAgentOwners } from '../agents/owners';
import { useWiki } from './wiki-context';
import { editingCapability } from '../editing/capability';
import './docs.css';

// A space's Wiki (#112, #869): the page, edited where it is read; an earlier version, read as it was written; and the
// History with compare and restore. Everything here is visible to the people with access to the space.

/**
 * The page editor comes with the page: the loader has its code before the first render, so the page never changes kind
 * after it is on screen. If that code cannot load, the page is read as saved.
 */
let editorModule: typeof import('../editing/WikiEditor') | null = null;
const loadEditor = () => (editorModule ? Promise.resolve() : import('../editing/WikiEditor').then((module) => { editorModule = module; }, () => undefined));

/** A doc of another project is not found here, whatever its id. */
function inProject(doc: Doc, projectId: string | undefined) {
  if (doc.projectId.toLowerCase() !== (projectId ?? '').toLowerCase()) throw new Response('Not found', { status: 404 });
}

/** The Wiki without a page to open: the space has none yet (otherwise the loader opens one). */
export function WikiHome() {
  return <NoPages />;
}

function DocRow({ doc, showProject }: { doc: DocSummary; showProject?: boolean }) {
  return (
    <li>
      <Link className="doc-item" to={docUrl(doc.projectId, doc.id)}>
        <span className="doc-item__ic" aria-hidden="true"><Icon name="doc" size={16} /></span>
        <span className="doc-item__b">
          <span className="doc-item__t">{doc.title}</span>
          <span className="doc-item__s">
            {showProject ? <>{doc.projectName} · </> : null}
            {authorLabel(doc.updatedBy)} · {doc.reason}
          </span>
          {doc.excerpt ? <span className="doc-item__x">{doc.excerpt}</span> : null}
        </span>
        <span className="doc-item__r"><time dateTime={doc.updatedAt}>{shortDate(doc.updatedAt)}</time></span>
      </Link>
    </li>
  );
}

/** Home › Docs: the docs of every project the person can read in the workspace. */
export function WorkspaceDocs() {
  const { workspaces } = useShellData();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ids = workspaces.map((space) => space.id).join(',');
  useEffect(() => {
    const controller = new AbortController();
    // F-030 (#655): a space that locked since the shell read it lists nothing until it is unlocked; the others still do.
    Promise.all(ids ? ids.split(',').map((id) => unlessLocked(listWorkspaceDocs(id, controller.signal), [])) : [])
      .then((lists) => setDocs(lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ids]);
  return (
    <div className="pane-scroll">
      <div className="pane-in doc-list">
        {failed ? <p className="doc-notice" role="alert"><Icon name="alert" size={14} />Wiki pages could not be loaded. Check the connection and try again.</p> : null}
        {docs === null && !failed ? <p className="doc-muted" aria-busy="true">Loading docs…</p> : null}
        {docs && !docs.length ? (
          <div className="view-empty"><EmptyState icon="doc" title="No docs yet">
            <p>Notes worth keeping, what you learned from an experiment, and how things work, written with the people in your spaces, will collect here.</p>
          </EmptyState></div>
        ) : null}
        {docs?.length ? <section className="doc-group" aria-labelledby="docs-all"><h2 className="doc-group__h" id="docs-all">Wiki pages in your spaces <span>{docs.length}</span></h2><ul className="doc-ul">{docs.map((doc) => <DocRow key={doc.id} doc={doc} showProject />)}</ul></section> : null}
      </div>
    </div>
  );
}

/** Live: the room's head read with the page (null when the room is not reachable now, and the editor connects itself). */
export type PageMode = { live: true; head: LiveDocBootstrap | null } | { live: false };
interface PageData { doc: Doc; mode: PageMode }

export async function docLoader({ params, request }: LoaderFunctionArgs): Promise<PageData> {
  const [doc, mode] = await Promise.all([
    getDoc(params.docId!, request.signal),
    // The shared room's head comes with the page, so the editor opens it without a second read.
    editingCapability().then((capability): Promise<PageMode> | PageMode => capability !== 'configured' ? { live: false }
      : getLiveDoc(params.docId!, request.signal).then((head) => ({ live: true, head }), (cause: unknown) =>
        (cause instanceof ApiError && cause.code === 'LIVE_EDITING_DISABLED' ? { live: false } : { live: true, head: null }))),
    loadEditor(),
  ]);
  inProject(doc, params.projectId);
  return { doc, mode };
}

/** The open page is its own source: only a move to another page reads it again. */
export function docShouldRevalidate({ currentUrl, nextUrl }: ShouldRevalidateFunctionArgs) {
  return currentUrl.pathname !== nextUrl.pathname || currentUrl.search !== nextUrl.search;
}

/** A message citing a doc version (#36 citation) opens it in the doc reader. */
export function redirectDocMaterial(projectId: string, docId: string, version?: number) {
  return redirect(`/projects/${projectId}/docs/${docId}${version ? `/versions/${version}` : ''}`);
}

/** The page: edited where it is read (#869). */
export function DocPage() {
  const { doc, mode } = useLoaderData() as PageData;
  const { project } = useWiki();
  const { me } = useShellData();
  useRegisterLiveHere({ projectId: project.id, context: { type: 'doc', id: doc.id }, label: doc.title },
    { ref: { type: 'material', id: doc.id, version: doc.version }, label: doc.title, what: `doc · version ${doc.version}` });
  const Editor = editorModule?.PageEditor;
  if (!Editor) return <ReadPage doc={doc} shown={doc} notice={<p className="doc-notice" role="alert"><Icon name="alert" size={14} />The editor could not load. Reload to write on this page.</p>} />;
  return <Editor key={`${me.user.id}:${doc.id}`} doc={doc} project={project} userId={me.user.id} mode={mode} />;
}

interface VersionData { doc: Doc; shown: DocVersion }

export async function docVersionLoader({ params, request }: LoaderFunctionArgs): Promise<VersionData> {
  const doc = await getDoc(params.docId!, request.signal);
  inProject(doc, params.projectId);
  const version = Number(params.version);
  const shown = Number.isInteger(version) && version >= 1 && version !== doc.version ? await getVersion(doc.id, version, request.signal) : doc;
  return { doc, shown };
}

/** An earlier version, read as it was written, with Restore. */
export function VersionPage() {
  const { doc, shown } = useLoaderData() as VersionData;
  const { project } = useWiki();
  const base = docUrl(project.id, doc.id);
  useRegisterLiveHere({ projectId: project.id, context: { type: 'doc', id: doc.id }, label: doc.title },
    { ref: { type: 'material', id: doc.id, version: shown.version }, label: shown.title, what: `doc · earlier version ${shown.version}` });
  const earlier = shown.version !== doc.version;
  return (
    <ReadPage doc={doc} shown={shown} notice={(
      <p className="doc-notice"><Icon name="undo" size={14} />{earlier ? 'You are reading an earlier version.' : 'You are reading a saved version.'} It stays as it was written.
        <Link to={base}>Open the current version</Link>
        {earlier ? <><RestoreButton docUrl={base} version={shown.version} quiet /><Link to={`${base}/history?from=${shown.version}&to=${doc.version}`}>What changed since</Link></> : null}</p>
    )} />
  );
}

/** A saved version as the server rendered it, read only. */
function ReadPage({ doc, shown, notice }: { doc: Doc; shown: DocVersion; notice: ReactNode }) {
  const { project } = useWiki();
  const owners = useAgentOwners(project);
  const [prose, setProse] = useState<HTMLElement | null>(null);
  const { headings, marks } = useProse(prose, shown.html, project.id, owners);
  const onClick = useReferenceClicks();
  const landing = useRef<() => void>(() => undefined);
  useEffect(() => () => landing.current(), []);
  const missing = shown.mentions.filter((item) => !item.path).length;
  const go = (id: string) => {
    const node = prose?.querySelector<HTMLElement>(`#${id}`);
    const scroller = prose?.closest<HTMLElement>('.wiki-main');
    if (!node || !scroller) return;
    landing.current();
    landing.current = scrollPage(scroller, () => (node.isConnected ? scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24 : null));
    node.focus({ preventScroll: true });
  };
  return (
    <PageFrame docId={doc.id} title={shown.title} headings={headings} onHeading={go}
      meta={<>Version {shown.version} · <time dateTime={shown.createdAt} title={longDate(shown.createdAt)}>{shortDate(shown.createdAt)}</time> · {authorLabel(shown.author)}</>}
      shown={{ title: shown.title, body: () => shown.body, version: shown.version, current: shown.version === doc.version }}
      notices={notice} onBodyClick={onClick}>
      {shown.body.trim()
        ? <><DocProse html={shown.html} onReady={setProse} />
          {/* The cards and marks are portals into the page's links: their clicks bubble through React from here, so a tap on a card's text opens it in place (#763 P2-5). */}
          <span hidden>{marks}</span></>
        : <p className="doc-muted doc-empty">This version has no text.</p>}
      {missing ? <p className="doc-notice"><Icon name="alert" size={14} />{missing === 1 ? 'One link points' : `${missing} links point`} to something that is not in this space or no longer exists. It shows as plain text.</p> : null}
    </PageFrame>
  );
}

interface HistoryData { doc: Doc; versions: DocVersionSummary[]; from: DocVersion | null; to: DocVersion }

export async function docHistoryLoader({ params, request }: LoaderFunctionArgs): Promise<HistoryData> {
  const doc = await getDoc(params.docId!, request.signal);
  inProject(doc, params.projectId);
  const search = new URL(request.url).searchParams;
  const versions = await listVersions(doc.id, request.signal);
  const pick = (value: string | null, fallback: number) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= doc.version ? number : fallback;
  };
  const toNumber = pick(search.get('to'), doc.version);
  const fromNumber = pick(search.get('from'), toNumber - 1);
  const [to, from] = await Promise.all([
    toNumber === doc.version ? Promise.resolve<DocVersion>(doc) : getVersion(doc.id, toNumber, request.signal),
    fromNumber >= 1 && fromNumber !== toNumber ? getVersion(doc.id, fromNumber, request.signal) : Promise.resolve(null),
  ]);
  return { doc, versions, from, to };
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  if (!rows.some((row) => row.kind === 'added' || row.kind === 'removed')) return <p className="doc-muted">The text is the same in both versions.</p>;
  return (
    <ol className="doc-diff" aria-label="Changes in the text">
      {rows.map((row, index) => row.kind === 'fold'
        ? <li key={index} className="doc-diff__fold">{row.count} unchanged {row.count === 1 ? 'line' : 'lines'}</li>
        : (
          <li key={index} className={`doc-diff__row doc-diff__row--${row.kind}`}>
            <span className="doc-diff__m" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</span>
            {row.kind !== 'same' ? <span className="ui-vh">{row.kind === 'added' ? 'Added: ' : 'Removed: '}</span> : null}
            <span className="doc-diff__t">{row.parts.map((part, i) => part.changed && row.kind !== 'same'
              ? (row.kind === 'added' ? <ins key={i}>{part.text}</ins> : <del key={i}>{part.text}</del>)
              : <span key={i}>{part.text}</span>)}{row.parts.every((part) => !part.text) ? ' ' : null}</span>
          </li>
        ))}
    </ol>
  );
}

/** What changed between two versions: the page as it reads, or its exact Markdown text (#511, AC-1, AC-2). */
function Changes({ from, to }: { from: DocVersion | null; to: DocVersion }) {
  const [view, setView] = useState<'rendered' | 'markdown'>('rendered');
  const onClick = useReferenceClicks();
  const rows = useMemo(() => {
    const titles = new Map([...(from?.mentions ?? []), ...to.mentions].filter((item) => item.title).map((item) => [`${item.type}:${item.id}`, item.title]));
    return diffDocs(readableRefs(from?.body ?? '', titles), readableRefs(to.body, titles));
  }, [from, to]);
  const page = useMemo(() => blockDiff(from?.html ?? '', to.html), [from, to.html]);
  const stats = diffStats(rows);
  return (
    <section className="doc-changes" aria-labelledby="doc-changes-h">
      <header className="doc-changes__top">
        <h3 id="doc-changes-h">
          {from ? <>v{from.version} → v{to.version}</> : <>Version {to.version}, the first</>}
          <span className="doc-changes__stat"> · +{stats.added} −{stats.removed}</span>
        </h3>
        <div className="doc-seg" role="group" aria-label="Show the changes as">
          <button type="button" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>Rendered</button>
          <button type="button" aria-pressed={view === 'markdown'} onClick={() => setView('markdown')}>Markdown</button>
        </div>
      </header>
      <p className="doc-changes__why">{from ? <>From {authorLabel(from.author)}’s version of {longDate(from.createdAt)} to </> : null}{authorLabel(to.author)}’s of {longDate(to.createdAt)} · {to.reason}</p>
      {from && from.title !== to.title ? <ul className="doc-changes__facts"><li>Title: <del>{from.title}</del> → <ins>{to.title}</ins></li></ul> : null}
      {view === 'markdown' ? <DiffView rows={rows} /> : page.changed ? (
        <>
          <section className="doc-changes__page" aria-label="Changes in the text">
            <DocProse html={page.html} onClick={onClick} />
          </section>
          <p className="doc-changes__key" aria-hidden="true"><ins>text</ins> added <del>text</del> removed</p>
        </>
      ) : <p className="doc-muted">The text is the same in both versions.</p>}
    </section>
  );
}

/**
 * Restore is an action, not an address (#946 review): the page opens with the version to bring back in its navigation
 * state, which no link can carry, and the page makes it the next version.
 */
function RestoreButton({ docUrl: base, version, quiet = false }: { docUrl: string; version: number; quiet?: boolean }) {
  const navigate = useNavigate();
  return (
    <button type="button" className={quiet ? 'ui-link wiki-restore-link' : 'ui-btn ui-btn--soft wiki-head__restore'} onClick={() => navigate(base, { state: { restore: version } })}>
      {quiet ? null : <Icon name="undo" size={14} />}{quiet ? 'Restore this version' : `Restore version ${version}`}
    </button>
  );
}

/** History (⋯ › History): every version with who made it and when, what changed between two, and Restore. */
export function DocHistory() {
  const { doc, versions, from, to } = useLoaderData() as HistoryData;
  const { project } = useWiki();
  const [, setSearch] = useSearchParams();
  const base = docUrl(project.id, doc.id);
  const compare = (next: { from?: number; to?: number }) => {
    const target = next.to ?? to.version;
    const source = next.from ?? (next.to ? target - 1 : from?.version ?? target - 1);
    setSearch(source >= 1 && source !== target ? { from: String(source), to: String(target) } : { to: String(target) });
  };
  // Restore brings back the earlier side of the comparison: the chosen version, or the one before the current page.
  const restore = to.version !== doc.version ? to.version : from?.version ?? null;
  return (
    <div className="wiki-page wiki-page--wide doc-history">
      <div className="wiki-head">
        <Link className="ui-btn ui-btn--quiet wiki-head__back" to={base}><Icon name="chevron-left" size={14} />Back to the page</Link>
        <p className="wiki-head__meta">History · {doc.version} {doc.version === 1 ? 'version' : 'versions'}</p>
        {restore ? <RestoreButton docUrl={base} version={restore} /> : null}
      </div>
      <h2 className="wiki-title__h wiki-title--plain">{doc.title}</h2>
      <div className="doc-history__grid">
        <section className="doc-history__list" aria-labelledby="doc-versions-h">
          <h3 className="doc-group__h" id="doc-versions-h">Versions</h3>
          <ol className="doc-versions">
            {versions.map((item) => (
              <li key={item.version}>
                <button type="button" className="doc-version" aria-current={item.version === to.version ? 'true' : undefined} onClick={() => compare({ to: item.version })}>
                  <span className="doc-version__dot" aria-hidden="true" />
                  <span className="doc-version__b">
                    <span className="doc-version__t">{item.reason}</span>
                    <span className="doc-version__s">v{item.version} · {authorLabel(item.author)} · {shortDate(item.createdAt)}</span>
                  </span>
                </button>
                <Link className="doc-version__open" to={item.version === doc.version ? base : `${base}/versions/${item.version}`} aria-label={`Read version ${item.version}`}>Read</Link>
              </li>
            ))}
          </ol>
        </section>
        <div className="doc-history__diff">
          {to.version > 1 ? (
            <label className="doc-compare">Compare with
              <Select value={from?.version ?? ''} onChange={(next) => compare({ from: Number(next) })}>
                {versions.filter((item) => item.version < to.version).map((item) => <Option key={item.version} value={item.version}>version {item.version} · {shortDate(item.createdAt)}</Option>)}
              </Select>
            </label>
          ) : null}
          <Changes from={from} to={to} />
        </div>
      </div>
    </div>
  );
}
