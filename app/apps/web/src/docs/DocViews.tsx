import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { unlessLocked } from '../encryption/api';
import { createPortal } from 'react-dom';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { Link, redirect, useLoaderData, useNavigate, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Doc, DocSummary, DocVersion, DocVersionSummary, ObjectLink, Project } from '@flux/contracts';
import { EmptyState, Icon, Spinner, Select, Option } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { docUrl, getDoc, getVersion, listVersions, listWorkspaceDocs } from './api';
import { diffDocs, diffStats, readableRefs, type DiffRow } from './diff';
import { draftKey, readKept } from './drafts';
import { STATE_LABEL, authorLabel, docLinks, kindLabel, longDate, pathOfLink, shortDate } from './format';
import { DocProse } from './DocProse';
import { DimIcon, DownloadButton, PageMenu, ShareButton, WikiBar, WikiIcon, usePhoneHeader } from './WikiParts';
import { EditedBy, Outline, OutlineChip, useProse } from './WikiRead';
import { blockDiff } from './block-diff';
import { useAgentOwners } from '../agents/owners';
import { useWiki } from './wiki-context';
import './docs.css';
import { editingCapability, useEditingCapability } from '../editing/capability';
import type { LiveReadingProps, LiveReadingState } from '../editing/LiveReading';
import { RefLink } from '../place/origin';

// The current page's shared working copy (#228) loads only with a configured live capability (#239
// review), so an ordinary wiki never evaluates its CRDT bundle. If that bundle cannot load, the page
// is read as saved.
//
// The reader must not change kind after it is on screen: a Suspense fallback holding the same page is a different place in the
// tree from the page inside the lazy component, so the swap would rebuild the whole page (its toolbar, an open menu, the focus)
// a moment after it appeared. The loader therefore has the bundle in hand before the first render (`loadLiveReading`), and the
// reader then renders it directly; the lazy path below is only for a reader reached some other way.
type LiveReadingComponent = (props: LiveReadingProps) => ReactNode;
function SavedReading({ render }: LiveReadingProps) { return <>{render(null)}</>; }
let loadedLiveReading: LiveReadingComponent | null = null;
const loadLiveReading = () => import('../editing/LiveReading').then((module) => { loadedLiveReading = module.LiveReading; }, () => { loadedLiveReading = SavedReading; });
const LiveReading = lazy(() => loadLiveReading().then(() => ({ default: loadedLiveReading! })));

// The project wiki (#112, two panes since #136): the reader with links and backlinks, and the
// version history with a diff, beside the page index (Wiki.tsx). Everything here is visible to the
// people with access to the project, and says so.

function useRefresh() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 20000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);
  return revalidator;
}

function Audience({ project }: { project: Project }) {
  return <p className="doc-audience"><Icon name="lock" size={13} />{project.name} · Everyone with project access can read these pages</p>;
}

/** A doc of another project is not found here, whatever its id. */
function inProject(doc: Doc, projectId: string | undefined) {
  if (doc.projectId.toLowerCase() !== (projectId ?? '').toLowerCase()) throw new Response('Not found', { status: 404 });
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest?.('[role="combobox"], [role="listbox"]'));
}

function DocRow({ doc, showProject }: { doc: DocSummary; showProject?: boolean }) {
  return (
    <li>
      <Link className="doc-item" to={docUrl(doc.projectId, doc.id)}>
        <span className="doc-item__ic" aria-hidden="true"><Icon name="doc" size={16} /></span>
        <span className="doc-item__b">
          <span className="doc-item__t">{doc.title}{doc.state === 'draft' ? <span className="doc-pill">Draft</span> : null}</span>
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

/** The wiki without a page to open: the project has none yet (otherwise the loader opens one). */
export function WikiHome() {
  const { project, docs, writable, compact, importing, importError, importErrorId, startImport } = useWiki();
  useRefresh();
  return (
    <>
      <WikiBar meta={<span>Wiki · {docs.length ? `${docs.length} ${docs.length === 1 ? 'page' : 'pages'}` : 'no pages yet'}</span>} />
      <div className="wiki-doc" data-shift>
        {docs.length ? <p className="doc-muted">Choose a page from the list.</p> : (
          <div className="view-empty"><EmptyState icon="doc" title="No pages yet">
            <p>{writable
              ? 'Write down how things work and what you learned: start a new page, or import a Markdown file. A result or decision can start a page from its details, and every change keeps the earlier version.'
              : `When people in ${project.name} write pages, they appear here.`}</p>
            {/* On a phone the page list is a chip row of pages only, so the first page starts here. */}
            {compact && writable ? (
              <div className="wiki-empty__acts">
                <Link className="ui-btn ui-btn--primary" to={`/projects/${project.id}/docs/new`}><Icon name="plus" size={16} />New page</Link>
                <button type="button" className="ui-btn ui-btn--secondary" onClick={startImport} aria-busy={importing || undefined}
                  aria-disabled={importing || undefined} aria-describedby={importError ? importErrorId : undefined}>
                  {importing ? <Spinner /> : <WikiIcon name="upload" size={16} />}Import .md
                </button>
              </div>
            ) : null}
          </EmptyState></div>
        )}
        <Audience project={project} />
      </div>
    </>
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
      <div className="pane-in doc-list" data-shift>
        {failed ? <p className="doc-notice" role="alert"><Icon name="alert" size={14} />Wiki pages could not be loaded. Check the connection and try again.</p> : null}
        {docs === null && !failed ? <p className="doc-muted" aria-busy="true">Loading docs…</p> : null}
        {docs && !docs.length ? (
          <div className="view-empty"><EmptyState icon="doc" title="No docs yet">
            <p>Notes worth keeping, what you learned from an experiment, and how things work, written with the people in your projects, will collect here.</p>
          </EmptyState></div>
        ) : null}
        {docs?.length ? <section className="doc-group" aria-labelledby="docs-all"><h2 className="doc-group__h" id="docs-all">Wiki pages in your projects <span>{docs.length}</span></h2><ul className="doc-ul">{docs.map((doc) => <DocRow key={doc.id} doc={doc} showProject />)}</ul></section> : null}
      </div>
    </div>
  );
}

interface ReaderData { doc: Doc; shown: DocVersion; historical: boolean }

export async function docLoader({ params, request }: LoaderFunctionArgs): Promise<ReaderData> {
  // The capability is known before the first render, so the reader never switches kinds after it.
  const [doc] = await Promise.all([
    getDoc(params.docId!, request.signal),
    // The shared reader's bundle comes with the page (not for an explicit version, which is read as saved).
    editingCapability().then((capability) => capability === 'configured' && params.version === undefined ? loadLiveReading() : undefined),
  ]);
  inProject(doc, params.projectId);
  const version = params.version ? Number(params.version) : null;
  const shown = version && version !== doc.version ? await getVersion(doc.id, version, request.signal) : doc;
  return { doc, shown, historical: params.version !== undefined };
}

/** A message citing a doc version (#36 citation) opens it in the doc reader. */
export function redirectDocMaterial(projectId: string, docId: string, version?: number) {
  return redirect(`/projects/${projectId}/docs/${docId}${version ? `/versions/${version}` : ''}`);
}

/** Opens a clicked doc reference in the app: work objects in the Details panel, the rest by route. */
function useReferenceClicks() {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  return (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const type = anchor.dataset.refType;
    const id = anchor.dataset.refId;
    if (id && (type === 'work' || type === 'decision' || type === 'result')) {
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

function LinkList({ title, links, end, projectId, empty }: { title: string; links: ObjectLink[]; end: 'from' | 'to'; projectId: string; empty?: string }) {
  const { openDetails } = useShellActions();
  if (!links.length && !empty) return null;
  const id = `doc-links-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className="doc-links" aria-labelledby={id}>
      <h3 id={id}>{title} {links.length ? <span>{links.length}</span> : null}</h3>
      {!links.length ? <p className="doc-muted">{empty}</p> : (
        <ul>
          {links.map((link) => {
            const ref = end === 'from' ? link.from : link.to;
            const label = (end === 'from' ? link.fromTitle : link.toTitle) || 'Untitled';
            const path = pathOfLink(projectId, link, end);
            const body = <><span className="doc-links__k">{kindLabel(ref.type)}</span><span className="doc-links__t">{label}</span><Icon name="chevron-right" size={14} /></>;
            return (
              <li key={link.id}>
                {path ? <RefLink className="doc-links__a" to={path}>{body}</RefLink>
                  : ref.type === 'work' || ref.type === 'decision' || ref.type === 'result'
                    ? <button type="button" className="doc-links__a" onClick={() => openDetails({ kind: ref.type as 'work' | 'decision' | 'result', id: ref.id })}>{body}</button>
                    : <span className="doc-links__a doc-links__a--static">{body}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Reads a doc, its current or an earlier version, with what it links to and what links here. */
export function DocReader() {
  const { doc, historical } = useLoaderData() as ReaderData;
  const { me } = useShellData();
  // Load the CRDT-backed reader only when configured, and never for an explicit version URL.
  const capability = useEditingCapability();
  if (capability !== 'configured' || historical) return <DocReading live={null} />;
  if (loadedLiveReading) {
    const Shared = loadedLiveReading;
    return <Shared docId={doc.id} userId={me.user.id} render={(live) => <DocReading live={live} />} />;
  }
  return <Suspense fallback={<DocReading live={null} />}>
    <LiveReading docId={doc.id} userId={me.user.id} render={(live) => <DocReading live={live} />} />
  </Suspense>;
}

function DocReading({ live }: { live: LiveReadingState | null }) {
  const { doc, shown, historical } = useLoaderData() as ReaderData;
  const { project, docs, writable, compact, menuSlot } = useWiki();
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRefresh();
  const owners = useAgentOwners(project);
  const [prose, setProse] = useState<HTMLElement | null>(null);
  const working = live?.working ?? null;
  const html = working?.html ?? shown.html;
  const text = working?.text ?? shown.body;
  const { headings, marks, cards } = useProse(prose, html, project.id, owners);
  const onClick = useReferenceClicks();
  const capability = useEditingCapability();
  const current = !historical && (capability === 'configured' || shown.version === doc.version);
  const savedVersion = working?.savedVersion ?? doc.version;
  useEffect(() => {
    if (!historical && savedVersion > doc.version && revalidator.state === 'idle') revalidator.revalidate();
  }, [historical, savedVersion, doc.version, revalidator]);
  const links = docLinks(doc);
  // F-034: a decision already shown as a card in the page is not listed again under it.
  const notCard = (link: ObjectLink) => !(link.to.type === 'decision' && cards.has(link.to.id));
  const sources = links.sources.filter(notCard), mentions = links.mentions.filter(notCard), backlinks = links.backlinks;
  const missing = shown.mentions.filter((item) => !item.path).length;
  const base = docUrl(project.id, doc.id);
  const edit = `${base}/edit`;
  const kept = writable && current && !!readKept(draftKey(me.user.id, doc.id, project.id));
  useRegisterLiveHere({ projectId: project.id, context: { type: 'doc', id: doc.id }, label: doc.title },
    { ref: { type: 'material', id: doc.id, version: shown.version }, label: shown.title,
      what: current ? `doc · version ${shown.version}` : `doc · earlier version ${shown.version}` });
  useEffect(() => {
    if (!writable || !current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
      const target = event.target as HTMLElement | null;
      if (document.getElementById('root')?.hasAttribute('data-modal') || (target && target !== document.body && !target.closest('.wiki-frame, #content'))) return;
      if (target?.closest('[role="dialog"]')) return;
      event.preventDefault();
      navigate(edit);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [writable, current, edit, navigate]);
  const historyTo = `${base}/history${current ? '' : `?to=${shown.version}`}`;
  const historyLabel = `History, ${doc.version} ${doc.version === 1 ? 'version' : 'versions'}`;
  const keptLink = kept ? <Link className="wiki-bar__kept" to={edit}>Unsaved changes in this tab</Link> : null;
  // An earlier version is read only: on the computer Edit stays in its place, dimmed (#511, AC-4).
  // Reading needs no dark primary (quiet buttons, #763): Edit is the toolbar's soft-fill button, one height with its icons.
  const editButton = !writable ? null : current
    ? <Link className={`ui-btn ui-btn--soft ${compact ? 'wiki-edit' : 'wiki-bar__primary'}`} data-slot="primary" to={edit} aria-label="Edit" aria-keyshortcuts="e"><Icon name="edit" size={16} /><span className="wiki-bar__label">Edit</span></Link>
    : compact ? null : <button type="button" className="ui-btn ui-btn--soft wiki-bar__primary" data-slot="primary" aria-label="Edit" disabled><Icon name="edit" size={16} /><span className="wiki-bar__label">Edit</span></button>;
  // The page's one menu: in the header of a narrow work area beside the computer's views, but never in the phone's header,
  // which is the same in every view (#507): there it ends the row of page chips, which stays at the top while the page is read.
  const phoneHeader = usePhoneHeader();
  const inStrip = compact && phoneHeader;
  const pageMenu = compact ? (
    <PageMenu sharePath={current ? base : `${base}/versions/${shown.version}`} shareVersion={current ? null : shown.version}
      shown={{ title: shown.title, body: text, version: shown.version, current }}
      history={<Link className="wiki-pop__item" to={historyTo} aria-label={historyLabel}><WikiIcon name="history" /><span><b>History</b><small>{doc.version} {doc.version === 1 ? 'version' : 'versions'}, {STATE_LABEL[shown.state].toLowerCase()}</small></span></Link>} />
  ) : null;
  return (
    <>
      <WikiBar compactInHeader phoneMeta={<span className="wiki-bar__title"><b>Wiki</b> · {docs.length} {docs.length === 1 ? 'page' : 'pages'}</span>}
        primary={compact ? undefined : editButton} meta={compact
          ? <span className="wiki-bar__title"><b>Wiki</b> · {docs.length} {docs.length === 1 ? 'page' : 'pages'}</span>
          : <><span className="doc-head__k">{STATE_LABEL[shown.state]} · version {shown.version}{current ? '' : ` of ${doc.version}`}</span>{keptLink}</>}>
        {compact ? (inStrip ? null : pageMenu) : (
          <>
            <OutlineChip headings={headings} scroller={prose?.closest<HTMLElement>('.wiki-main') ?? null} />
            <Link className="ui-icon-btn" data-slot="history" to={historyTo} aria-label={historyLabel} data-tip={`History · ${doc.version} ${doc.version === 1 ? 'version' : 'versions'}`}>
              <WikiIcon name="history" />
            </Link>
            <ShareButton path={current ? base : `${base}/versions/${shown.version}`} version={current ? null : shown.version} />
            <DownloadButton shown={{ title: shown.title, body: text, version: shown.version, current }} />
          </>
        )}
      </WikiBar>
      {inStrip && menuSlot ? createPortal(pageMenu, menuSlot) : null}
      <div className="wiki-read" key={doc.id}>
        <article className="wiki-doc wiki-doc--read doc" data-shift aria-labelledby="doc-title">
          {compact && keptLink ? <p className="doc-notice">{keptLink}</p> : null}
          {!current ? (
            <p className="doc-notice"><Icon name="undo" size={14} />{historical && shown.version === doc.version ? 'You are reading a saved version.' : 'You are reading an earlier version.'} It stays as it was written.
              <Link to={base}>Open the current version</Link><Link to={`${base}/history?from=${shown.version}&to=${doc.version}`}>What changed since</Link></p>
          ) : null}
          <header className="doc-head">
            <h2 id="doc-title" className="doc-head__t">{shown.title}</h2>
            <EditedBy editor={shown.author} at={shown.createdAt} reason={shown.reason} starter={doc.createdBy} startedAt={doc.startedAt} owners={owners} />
          </header>
          {working ? <p className="doc-notice" data-live-reader data-live-generation={working.generation} data-live-sequence={working.sequence}>Shared working copy · last saved version {working.savedVersion}. Sources and citations keep their saved version.{working.presence}</p> : null}
          {live?.problem ? <p className="doc-notice" role="alert">{live.problem}</p> : null}
          {text.trim()
            ? <><DocProse html={html} onReady={setProse} onClick={onClick} />
              {/* The cards and marks are portals into the page's links: their clicks bubble through React from here, not
                  through the prose, so a tap on a card's text opens it in place instead of following its address (#763 P2-5). */}
              <span hidden onClick={onClick}>{marks}</span></>
            : <p className="doc-muted doc-empty">This page has no text yet.{writable && current ? <> <Link to={edit}>Start writing</Link></> : null}</p>}
          {missing ? <p className="doc-notice"><Icon name="alert" size={14} />{missing === 1 ? 'One link points' : `${missing} links point`} to something that is not in this project or no longer exists. It shows as plain text.</p> : null}
          <div className="doc-foot">
            <LinkList title="Added from" links={sources} end="to" projectId={project.id} />
            {current ? <LinkList title="Links in this page" links={mentions} end="to" projectId={project.id} /> : null}
            <LinkList title="Linked from" links={backlinks} end="from" projectId={project.id} empty="Nothing links here yet. Other pages and work can link to this page." />
            <Audience project={project} />
            <p className="doc-ids">Started by {authorLabel(doc.createdBy)} · {shortDate(doc.startedAt)}</p>
          </div>
        </article>
        {!compact && headings.length > 1 ? <Outline headings={headings} scroller={prose?.closest<HTMLElement>('.wiki-main') ?? null} /> : null}
      </div>
      {compact ? editButton : null}
    </>
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
              : <span key={i}>{part.text}</span>)}{row.parts.every((part) => !part.text) ? ' ' : null}</span>
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
  const facts: ReactNode[] = [];
  if (from && from.title !== to.title) facts.push(<li key="t">Title: <del>{from.title}</del> → <ins>{to.title}</ins></li>);
  return (
    <section className="doc-changes" aria-labelledby="doc-changes-h">
      <header className="doc-changes__top">
        <h2 id="doc-changes-h">
          {from ? <>v{from.version} → v{to.version}</> : <>Version {to.version}, the first</>}
          <span className="doc-changes__stat"> · +{stats.added} −{stats.removed}</span>
          {from && from.state !== to.state ? <span className="doc-changes__stat"> · {STATE_LABEL[from.state]} → {STATE_LABEL[to.state]}</span> : null}
        </h2>
        <div className="doc-seg" role="group" aria-label="Show the changes as">
          <button type="button" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>Rendered</button>
          <button type="button" aria-pressed={view === 'markdown'} onClick={() => setView('markdown')}>Markdown</button>
        </div>
      </header>
      <p className="doc-changes__why">{from ? <>From {authorLabel(from.author)}’s version of {longDate(from.createdAt)} to </> : null}{authorLabel(to.author)}’s of {longDate(to.createdAt)} · {to.reason}</p>
      {facts.length ? <ul className="doc-changes__facts">{facts}</ul> : null}
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

/** Every version with its author, time and reason, and what changed between two of them. */
export function DocHistory() {
  const { doc, versions, from, to } = useLoaderData() as HistoryData;
  const { project, writable, compact } = useWiki();
  const [, setSearch] = useSearchParams();
  const base = docUrl(project.id, doc.id);
  const compare = (next: { from?: number; to?: number }) => {
    const target = next.to ?? to.version;
    const source = next.from ?? (next.to ? target - 1 : from?.version ?? target - 1);
    setSearch(source >= 1 && source !== target ? { from: String(source), to: String(target) } : { to: String(target) });
  };
  // Restore brings back the earlier side of the comparison: the chosen version, or the one before
  // the current page. It opens the editor with that text; nothing changes until Save version.
  const restore = to.version !== doc.version ? to.version : from?.version ?? null;
  const primary = !writable ? null : restore
    ? <Link className="ui-btn ui-btn--quiet wiki-bar__primary wiki-bar__restore" data-slot="primary" to={`${base}/edit?restore=${restore}`} aria-label={`Restore v${restore}`}><Icon name="undo" size={14} /><span className="wiki-bar__label">Restore v{restore}</span></Link>
    : <button type="button" className="ui-btn ui-btn--quiet wiki-bar__primary wiki-bar__restore" data-slot="primary" aria-label="Restore" disabled><Icon name="undo" size={14} /><span className="wiki-bar__label">Restore</span></button>;
  return (
    <>
      <WikiBar meta={<span className="doc-head__k">History · {doc.version} {doc.version === 1 ? 'version' : 'versions'}</span>}
        back={<Link className="ui-btn ui-btn--quiet wiki-bar__back" to={base}><Icon name="chevron-left" size={14} />Back to the page</Link>}
        primary={primary}>
        {compact ? null : <>
          <OutlineChip headings={null} />
          <DimIcon slot="history" name="history" label="History" />
          <DimIcon slot="share" name="share" label="Share this page" />
          <DimIcon slot="download" name="download" label="Download" />
        </>}
      </WikiBar>
      <div className="wiki-doc wiki-doc--wide doc doc-history" data-shift>
        <div className="doc-history__grid">
          <section className="doc-history__list" aria-labelledby="doc-versions-h">
            <h2 className="doc-group__h" id="doc-versions-h">Versions</h2>
            <ol className="doc-versions">
              {versions.map((item) => (
                <li key={item.version}>
                  <button type="button" className="doc-version" aria-current={item.version === to.version ? 'true' : undefined} onClick={() => compare({ to: item.version })}>
                    <span className="doc-version__dot" aria-hidden="true" />
                    <span className="doc-version__b">
                      <span className="doc-version__t">{item.reason}</span>
                      <span className="doc-version__s">v{item.version} · {STATE_LABEL[item.state]} · {authorLabel(item.author)} · {shortDate(item.createdAt)}</span>
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
    </>
  );
}
