import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { Link, redirect, useLoaderData, useNavigate, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Doc, DocSummary, DocVersion, DocVersionSummary, ObjectLink, Project } from '@flux/contracts';
import { EmptyState, Icon } from '../ui';
import { getProject } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { docUrl, getDoc, getVersion, listProjectDocs, listVersions, listWorkspaceDocs } from './api';
import { diffDocs, diffStats, readableRefs, type DiffRow } from './diff';
import { STATE_LABEL, authorLabel, docLinks, kindLabel, longDate, pathOfLink, shortDate } from './format';
import './docs.css';

// The Docs tab of a project (#112): a calm list with the last change, a reader with links and
// backlinks, and the version history with a diff. Everything here is visible to the people with
// access to the project, and says so.

function useRefresh() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 20000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [revalidator]);
}

function Audience({ project }: { project: Project }) {
  return <p className="doc-audience"><Icon name="lock" size={13} />{project.name} · Everyone with project access can read these docs</p>;
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

interface ListData { project: Project; docs: DocSummary[] }

export async function projectDocsLoader({ params, request }: LoaderFunctionArgs): Promise<ListData> {
  const project = await getProject(params.projectId!, request.signal);
  return { project, docs: await listProjectDocs(project.id, request.signal) };
}

/** The project's Docs tab. */
export function ProjectDocs() {
  const { project, docs } = useLoaderData() as ListData;
  useRefresh();
  const writable = project.access !== 'viewer';
  const drafts = docs.filter((doc) => doc.state === 'draft');
  const published = docs.filter((doc) => doc.state === 'published');
  return (
    <div className="pane-scroll">
      <div className="pane-in doc-list" data-shift>
        <div className="doc-list__head">
          <Audience project={project} />
          {writable ? <Link className="ui-btn ui-btn--secondary" to={`/projects/${project.id}/docs/new`}><Icon name="plus" />New doc</Link> : null}
        </div>
        {!docs.length ? (
          <div className="view-empty"><EmptyState icon="doc" title="No docs yet">
            <p>Write down how things work and what you learned. A result or decision can start a doc from its details, and every change keeps the earlier version.</p>
          </EmptyState></div>
        ) : null}
        {published.length ? <section className="doc-group" aria-labelledby="docs-published"><h2 className="doc-group__h" id="docs-published">Docs <span>{published.length}</span></h2><ul className="doc-ul">{published.map((doc) => <DocRow key={doc.id} doc={doc} />)}</ul></section> : null}
        {drafts.length ? <section className="doc-group" aria-labelledby="docs-drafts"><h2 className="doc-group__h" id="docs-drafts">Drafts <span>{drafts.length}</span></h2><ul className="doc-ul">{drafts.map((doc) => <DocRow key={doc.id} doc={doc} />)}</ul></section> : null}
      </div>
    </div>
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
    Promise.all(ids ? ids.split(',').map((id) => listWorkspaceDocs(id, controller.signal)) : [])
      .then((lists) => setDocs(lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ids]);
  return (
    <div className="pane-scroll">
      <div className="pane-in doc-list" data-shift>
        {failed ? <p className="doc-notice" role="alert"><Icon name="alert" size={14} />Docs could not be loaded. Check the connection and try again.</p> : null}
        {docs === null && !failed ? <p className="doc-muted" aria-busy="true">Loading docs…</p> : null}
        {docs && !docs.length ? (
          <div className="view-empty"><EmptyState icon="doc" title="No docs yet">
            <p>Notes worth keeping, what you learned from an experiment, and how things work, written with the people in your projects, will collect here.</p>
          </EmptyState></div>
        ) : null}
        {docs?.length ? <section className="doc-group" aria-labelledby="docs-all"><h2 className="doc-group__h" id="docs-all">Docs in your projects <span>{docs.length}</span></h2><ul className="doc-ul">{docs.map((doc) => <DocRow key={doc.id} doc={doc} showProject />)}</ul></section> : null}
      </div>
    </div>
  );
}

interface ReaderData { project: Project; doc: Doc; shown: DocVersion }

export async function docLoader({ params, request }: LoaderFunctionArgs): Promise<ReaderData> {
  const [project, doc] = await Promise.all([getProject(params.projectId!, request.signal), getDoc(params.docId!, request.signal)]);
  if (doc.projectId !== project.id) throw new Response('Not found', { status: 404 });
  const version = params.version ? Number(params.version) : null;
  const shown = version && version !== doc.version ? await getVersion(doc.id, version, request.signal) : doc;
  return { project, doc, shown };
}

/** A message citing a doc version (#36 citation) opens it in the doc reader. */
export function redirectDocMaterial(projectId: string, docId: string, version?: number) {
  return redirect(`/projects/${projectId}/docs/${docId}${version ? `/versions/${version}` : ''}`);
}

/** Opens a clicked doc reference in the app: work objects in the Details panel, the rest by route. */
function useReferenceClicks(projectId: string) {
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
    void projectId;
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
                {path ? <Link className="doc-links__a" to={path}>{body}</Link>
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
  const { project, doc, shown } = useLoaderData() as ReaderData;
  useRefresh();
  const onClick = useReferenceClicks(project.id);
  const writable = project.access !== 'viewer';
  const current = shown.version === doc.version;
  const { sources, mentions, backlinks } = docLinks(doc);
  const missing = shown.mentions.filter((item) => !item.path).length;
  const base = docUrl(project.id, doc.id);
  // The doc anchors a session; "Show this" points at exactly the version on screen.
  useRegisterLiveHere({ projectId: project.id, context: { type: 'doc', id: doc.id }, label: doc.title },
    { ref: { type: 'material', id: doc.id, version: shown.version }, label: shown.title, what: current ? `doc · version ${shown.version}` : `doc · earlier version ${shown.version}` });
  return (
    <div className="pane-scroll">
      <article className="pane-in doc" data-shift aria-labelledby="doc-title">
        <nav className="doc-crumb" aria-label="Breadcrumb"><Link to={`/projects/${project.id}/docs`}><Icon name="chevron-left" size={14} />Docs</Link></nav>
        <header className="doc-head">
          <p className="doc-head__k">{STATE_LABEL[shown.state]} · version {shown.version}{current ? '' : ` of ${doc.version}`}</p>
          <h2 id="doc-title" className="doc-head__t">{shown.title}</h2>
          <p className="doc-head__change"><span>{authorLabel(shown.author)}</span> · <time dateTime={shown.createdAt}>{longDate(shown.createdAt)}</time> · <span className="doc-head__why">{shown.reason}</span></p>
          <div className="doc-head__acts">
            {writable && current ? <Link className="ui-btn ui-btn--secondary" to={`${base}/edit`} aria-keyshortcuts="e"><Icon name="edit" />Edit</Link> : null}
            <Link className="ui-btn ui-btn--quiet" to={`${base}/history${current ? '' : `?to=${shown.version}`}`}>History · {doc.version} {doc.version === 1 ? 'version' : 'versions'}</Link>
          </div>
        </header>
        {!current ? (
          <p className="doc-notice"><Icon name="undo" size={14} />You are reading an earlier version. It stays as it was written.
            <Link to={base}>Open the current version</Link><Link to={`${base}/history?from=${shown.version}&to=${doc.version}`}>What changed since</Link></p>
        ) : null}
        {shown.body.trim()
          ? <div className="doc-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: shown.html }} />
          : <p className="doc-muted doc-empty">This doc has no text yet.{writable && current ? <> <Link to={`${base}/edit`}>Start writing</Link></> : null}</p>}
        {missing ? <p className="doc-notice"><Icon name="alert" size={14} />{missing === 1 ? 'One link points' : `${missing} links point`} to something that is not in this project or no longer exists. It shows as plain text.</p> : null}
        <div className="doc-foot">
          <LinkList title="Added from" links={sources} end="to" projectId={project.id} />
          {current ? <LinkList title="Links in this doc" links={mentions} end="to" projectId={project.id} /> : null}
          <LinkList title="Linked from" links={backlinks} end="from" projectId={project.id} empty="Nothing links here yet. Other docs and work can link to this doc." />
          <Audience project={project} />
          <p className="doc-ids">Started by {authorLabel(doc.createdBy)} · {shortDate(doc.startedAt)}</p>
        </div>
      </article>
    </div>
  );
}

interface HistoryData { project: Project; doc: Doc; versions: DocVersionSummary[]; from: DocVersion | null; to: DocVersion }

export async function docHistoryLoader({ params, request }: LoaderFunctionArgs): Promise<HistoryData> {
  const [project, doc] = await Promise.all([getProject(params.projectId!, request.signal), getDoc(params.docId!, request.signal)]);
  if (doc.projectId !== project.id) throw new Response('Not found', { status: 404 });
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
  return { project, doc, versions, from, to };
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

function Changes({ from, to }: { from: DocVersion | null; to: DocVersion }) {
  const rows = useMemo(() => {
    const titles = new Map([...(from?.mentions ?? []), ...to.mentions].filter((item) => item.title).map((item) => [`${item.type}:${item.id}`, item.title]));
    return diffDocs(readableRefs(from?.body ?? '', titles), readableRefs(to.body, titles));
  }, [from, to]);
  const stats = diffStats(rows);
  const facts: ReactNode[] = [];
  if (from && from.title !== to.title) facts.push(<li key="t">Title: <del>{from.title}</del> → <ins>{to.title}</ins></li>);
  if (from && from.state !== to.state) facts.push(<li key="s">State: {STATE_LABEL[from.state]} → {STATE_LABEL[to.state]}</li>);
  return (
    <section className="doc-changes" aria-labelledby="doc-changes-h">
      <h3 id="doc-changes-h">{from ? <>Version {from.version} → {to.version}</> : <>Version {to.version}, the first</>}</h3>
      <p className="doc-changes__why">{from ? <>From {authorLabel(from.author)}’s version of {longDate(from.createdAt)} to </> : null}{authorLabel(to.author)}’s of {longDate(to.createdAt)} · {to.reason}</p>
      {facts.length ? <ul className="doc-changes__facts">{facts}</ul> : null}
      <p className="doc-muted">{stats.added} {stats.added === 1 ? 'line' : 'lines'} added · {stats.removed} removed</p>
      <DiffView rows={rows} />
    </section>
  );
}

/** Every version with its author, time and reason, and what changed between two of them. */
export function DocHistory() {
  const { project, doc, versions, from, to } = useLoaderData() as HistoryData;
  const [, setSearch] = useSearchParams();
  const base = docUrl(project.id, doc.id);
  const compare = (next: { from?: number; to?: number }) => {
    const target = next.to ?? to.version;
    const source = next.from ?? (next.to ? target - 1 : from?.version ?? target - 1);
    setSearch(source >= 1 && source !== target ? { from: String(source), to: String(target) } : { to: String(target) });
  };
  return (
    <div className="pane-scroll">
      <div className="pane-in doc doc-history" data-shift>
        <nav className="doc-crumb" aria-label="Breadcrumb"><Link to={base}><Icon name="chevron-left" size={14} />{doc.title}</Link></nav>
        <header className="doc-head">
          <p className="doc-head__k">History · {doc.version} {doc.version === 1 ? 'version' : 'versions'}</p>
          <h2 className="doc-head__t">What changed in “{doc.title}”</h2>
          <p className="doc-head__change">Every version stays as it was written. Messages that cite a version keep reading that version.</p>
        </header>
        <div className="doc-history__grid">
          <section className="doc-history__list" aria-labelledby="doc-versions-h">
            <h3 className="doc-group__h" id="doc-versions-h">Versions</h3>
            <ol className="doc-versions">
              {versions.map((item) => (
                <li key={item.version}>
                  <button type="button" className="doc-version" aria-current={item.version === to.version ? 'true' : undefined} onClick={() => compare({ to: item.version })}>
                    <span className="doc-version__n">v{item.version}</span>
                    <span className="doc-version__b"><span className="doc-version__t">{item.reason}</span><span className="doc-version__s">{authorLabel(item.author)} · {shortDate(item.createdAt)}{item.state === 'draft' ? ' · draft' : ''}</span></span>
                  </button>
                  <Link className="doc-version__open" to={item.version === doc.version ? base : `${base}/versions/${item.version}`} aria-label={`Read version ${item.version}`}>Read</Link>
                </li>
              ))}
            </ol>
          </section>
          <div className="doc-history__diff">
            {to.version > 1 ? (
              <label className="doc-compare">Compare with
                <select value={from?.version ?? ''} onChange={(event) => compare({ from: Number(event.target.value) })}>
                  {versions.filter((item) => item.version < to.version).map((item) => <option key={item.version} value={item.version}>version {item.version} · {shortDate(item.createdAt)}</option>)}
                </select>
              </label>
            ) : null}
            <Changes from={from} to={to} />
          </div>
        </div>
      </div>
    </div>
  );
}
