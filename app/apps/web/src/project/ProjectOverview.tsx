import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DecisionRowProjection, NamedPrincipal, NativeWorkRow, WorkRowProjection, ResultRowProjection } from '@flux/contracts';
import { AgentIdentity, Icon, type IconName } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions, type DetailsView, type OverviewView } from '../app/shellContext';
import { decisionLine, statusPhrase } from '../work/format';
import { useOverviewWork } from '../work/useOverviewWork';
import { WorkPagination } from '../work/WorkPagination';
import { audienceLine, useProjectShell } from './data';
import { docUrl } from '../docs/api';
import { useWorkspaceEncryption } from '../encryption/state';
import { useOpenConversation } from './OverviewContext';
import { agentDisplayName } from '../docs/format';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import './overview.css';
import { RefLink } from '../place/origin';

/** Hooks run before the shell is known; this stands in for it and is never shown. */

interface Row {
  key: string;
  icon: IconName;
  kind: string;
  title: string;
  sub?: ReactNode;
  /** A short count or word at the row's right, before the chevron. */
  end?: string;
  need?: boolean;
  open?: DetailsView;
  to?: string;
  native?: { kind: NativeWorkRow['kind']; id: string };
}

/** Sub-line parts joined with " · "; an agent's identity (Kreska, "Agent", "for <owner>") stays one part. */
function dotted(parts: ReactNode[]): ReactNode {
  return parts.filter(Boolean).map((part, index) => <Fragment key={index}>{index ? ' · ' : null}{part}</Fragment>);
}

/** A single page of objects has no pager (#512, AC-6); while the page is unread the pager keeps its own loading state. */
const multiPage = (page: { previousCursor: string | null; nextCursor: string | null } | null) => !page || !!page.previousCursor || !!page.nextCursor;

function Rows({ label, rows, empty, controls }: { label: string; rows: Row[]; empty?: ReactNode; controls?: ReactNode }) {
  const { openDetails } = useShellActions();
  const [node, setNode] = useState<HTMLUListElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const attachList = useCallback((list: HTMLUListElement | null) => { setNode(list); setOverflow(false); }, []);
  useEffect(() => {
    if (!node || !controls) return;
    const measure = () => setOverflow(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [node, controls, rows]);
  const id = `ov-${label.toLowerCase().replace(/\W+/g, '-')}`;
  if (!rows.length && !empty && !controls) return null;
  return (
    <section className="details__sec ov-sec" aria-labelledby={id}>
      <h4 id={id}>{label}</h4>
      {controls}
      {rows.length ? (
        <ul className="ov-rows" ref={attachList}>
          {rows.map((row) => {
            const body = <>
              <Icon name={row.icon} size={16} className="ov-row__ic" />
              <span className="ov-row__b">
                {row.kind ? <span className="ov-row__k">{row.kind}</span> : null}
                <span className="ov-row__t">{row.title}</span>
                {row.sub ? <span className={`ov-row__s${row.need ? ' ws-need' : ''}`}>{row.sub}</span> : null}
              </span>
              {row.end ? <span className="ov-row__n">{row.end}</span> : null}
              <Icon name="chevron-right" size={16} className="ov-row__go" />
            </>;
            return <li key={row.key}>{row.to
              ? <RefLink className="ov-row" to={row.to}>{body}</RefLink>
              : <button type="button" className="ov-row" data-work-kind={row.native?.kind} data-work-id={row.native?.id} onClick={() => openDetails(row.open)}>{body}</button>}</li>;
          })}
        </ul>
      ) : <p className="ov-empty">{empty}</p>}
      {controls && node && rows.length > 0 && overflow ? <p className="ov-scroll-hint"><Icon name="chevron-down" size={12} />Scroll in this list to explore all {rows.length} objects on this page.</p> : null}
    </section>
  );
}

/**
 * Details for a project (#117, direction C "overview"): what the open conversation — or one of
 * its messages — is connected to, each one step away: the current state, linked work, decisions
 * and results, sources, sketches and docs, and exactly who can see it. Nothing here is a
 * permanent panel; it opens with Details, the state line or a message's Details action.
 */
export function ProjectOverview({ messageId, selection, onBack }: { messageId?: string; selection?: OverviewView['selection']; onBack: () => void }) {
  const shell = useProjectShell();
  const open = useOpenConversation();
  const { me } = useShellData();
  const { closePanel } = useShellActions();
  const read = useOverviewWork(me.user.id, shell?.project.id ?? null, open?.conversation?.id ?? null, messageId);
  const owners = useAgentOwners(shell?.project);
  const encrypted = !!useWorkspaceEncryption(shell?.project.workspaceId);
  if (!shell) return null;
  const { project, people, sketches, docs } = shell;
  // An agent is named with Kreska, the "Agent" tag and its owner; a person by name only.
  // A retained agent's owner comes from the row's scoped relation, resolved against this fresh audience only.
  const byline = (who: NamedPrincipal): ReactNode =>
    who.kind === 'agent' ? <AgentIdentity name={who.name} owner={agentAuthorOwner(who, owners)} icon={14} /> : who.name;
  const conversation = open?.conversation ?? null;
  // Older messages loaded by the feed are absent from the route's latest-message window.
  // Keep exactly the selected native message, scoped to its reader/project/conversation,
  // and expose it only after the current native association read verifies that source.
  // A root's Details also work from the stream (UI116-1), while no thread or another thread is open:
  // roots are the stream's own messages (sequence 1) of this project.
  const selected = selection?.accountId === me.user.id && selection.projectId === project.id
    && selection.message.id === messageId && (selection.message.conversationId === conversation?.id || selection.message.sequence === 1)
    ? selection.message : null;
  const message = messageId && read.page ? conversation?.messages.find((item) => item.id === messageId)
    ?? open?.roots?.roots.find((root) => root.message.id === messageId)?.message ?? selected : null;
  const messageMode = !!messageId;
  // The project's own Details (no thread, no message) are the structured overview of #512; a thread's or a
  // message's Details list what it touches.
  const projectMode = !messageMode && !conversation;
  const base = `/projects/${project.id}`;

  // One native row window for every matching role, including Related-only objects.
  // Conversation scope covers all native messages, independently of its source-count window.
  const rows = read.page?.items ?? [];
  const work = rows.filter((item): item is WorkRowProjection => item.kind === 'work');
  const decisions = rows.filter((item): item is DecisionRowProjection => item.kind === 'decision');
  const results = rows.filter((item): item is ResultRowProjection => item.kind === 'result');
  const workRow = (item: WorkRowProjection): Row => ({ key: `work:${item.id}`, native: item, icon: 'tasks', kind: 'Task', title: item.title, sub: dotted([statusPhrase(item), item.owner ? byline(item.owner) : null]), open: { kind: 'work', id: item.id } });
  const decisionRow = (item: DecisionRowProjection): Row => ({ key: `decision:${item.id}`, native: item, icon: 'rule', kind: item.status === 'accepted' ? 'Accepted decision' : item.status === 'proposed' ? 'Proposed decision' : 'Replaced decision', title: item.title, sub: decisionLine(item).split(' · ').slice(1).join(' · ') || undefined, need: item.status === 'proposed', open: { kind: 'decision', id: item.id } });
  const resultRow = (item: ResultRowProjection): Row => ({ key: `result:${item.id}`, native: item, icon: 'result', kind: 'Result', title: item.title, sub: dotted([`${item.finding === 'negative' ? 'Negative' : 'Positive'} result`, byline(item.createdBy)]), open: { kind: 'result', id: item.id } });
  const linked = [...decisions.filter((item) => item.status === 'proposed').map(decisionRow), ...decisions.filter((item) => item.status !== 'proposed').map(decisionRow), ...work.map(workRow), ...results.map(resultRow)];
  const byRef = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  const relationItems = read.links?.items ?? [];

  // Sources: versions cited by messages here, and materials the linked objects are based on.
  const titles = new Map((open?.materials ?? []).map((material) => [`${material.materialId}:${material.version}`, material.title]));
  const sources = new Map<string, Row>();
  for (const item of messageMode ? message ? [message] : [] : conversation?.messages ?? []) {
    if (!item.source) continue;
    const key = `${item.source.materialId}:${item.source.version}`;
    sources.set(key, { key, icon: 'doc', kind: `Source · v${item.source.version}`, title: titles.get(key) ?? 'Saved material', sub: 'Cited in this conversation', to: `/materials/${item.source.materialId}/versions/${item.source.version}` });
  }
  const thoughts = new Map<string, Row>();
  for (const link of relationItems) {
    const object = byRef.get(`${link.from.type}:${link.from.id}`);
    if (!object) continue;
    if (link.to.type === 'material') {
      const key = `${link.to.id}:${link.to.version}`;
      sources.set(key, { key, icon: 'doc', kind: `Source · v${link.to.version}`, title: link.toTitle, sub: sources.get(key)?.sub ?? `Used by “${object.title}”`, to: `/materials/${link.to.id}/versions/${link.to.version}` });
    }
    if (link.to.type === 'thought' && link.sketchId && !thoughts.has(link.to.id)) {
      thoughts.set(link.to.id, { key: link.to.id, icon: 'map', kind: 'Thought on a map', title: link.toTitle, sub: `Linked to “${object.title}”`, to: `${base}/map/${link.sketchId}#thought-${link.to.id}` });
    }
  }
  const sketchRows: Row[] = [...thoughts.values(), ...(messageMode ? [] : (sketches?.items ?? []).slice(0, 3).map((sketch) => ({ key: sketch.id, icon: 'map' as const, kind: 'Map', title: sketch.title, sub: <>Started by {sketch.createdBy.id === me.user.id ? 'you' : byline(sketch.createdBy)}</>, to: `${base}/map/${sketch.id}` })))];
  const moreSketches = !messageMode && sketches && sketches.total > 3;

  // Docs that include or mention what is linked here, then the project's latest docs.
  const docRows = new Map<string, Row>();
  for (const link of relationItems) {
    if (link.from.type !== 'doc' || (link.to.type !== 'decision' && link.to.type !== 'result')) continue;
    const object = byRef.get(`${link.to.type}:${link.to.id}`);
    if (object && (!docRows.has(link.from.id) || link.role === 'source')) docRows.set(link.from.id, { key: link.from.id, icon: 'doc', kind: link.role === 'source' ? 'Wiki page · includes it' : 'Wiki page · mentions it', title: link.fromTitle, sub: `“${object.title}”`, to: docUrl(project.id, link.from.id) });
  }
  if (!messageMode) for (const doc of (docs ?? []).slice(0, 3)) {
    if (!docRows.has(doc.id)) docRows.set(doc.id, { key: doc.id, icon: 'doc', kind: 'Wiki page', title: doc.title, sub: dotted([<>Changed by {doc.updatedBy.kind === 'human' && doc.updatedBy.id === me.user.id ? 'you' : byline(doc.updatedBy)}</>, doc.reason]), to: docUrl(project.id, doc.id) });
  }
  const moreDocs = !messageMode && docs && docs.length > 3;
  const noLinkedContext = read.objects.phase === 'idle' || read.page && (read.page.total === 0
    || read.page.total === rows.length && read.links?.total === 0);

  const connected: Row[] = projectMode && project.access === 'manager' ? [{ key: 'github', icon: 'link', kind: '', title: 'GitHub repositories', to: `${base}/github` }] : [];
  const author: ReactNode = message ? (message.authorId === null
    ? <AgentIdentity name={agentDisplayName(message.author)} owner={agentAuthorOwner(message.author, owners)} icon={14} />
    : message.authorId === me.user.id ? 'you' : people?.find((person) => person.id === message.authorId)?.name ?? 'a member') : null;
  const title: ReactNode = messageMode ? message ? <>Message from {author}</> : 'Message' : conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;

  return (
    <div className={`details ov${projectMode ? ' ov--project' : ''}`} data-overview-phase={read.objects.phase} data-overview-observed-at={read.page?.observedAt} data-overview-relations-phase={read.relations.phase} data-overview-relations-observed-at={read.links?.observedAt}>
      {messageMode ? <button type="button" className="details__back" onClick={onBack}><Icon name="chevron-left" size={14} />{conversation ? 'This conversation' : 'Space'}</button> : null}
      {projectMode ? <>
        {/* The space itself, once: its tile and name, then who is in it (#512, AC-2). */}
        <header className="ov-head">
          <span className="ov-tile" aria-hidden="true">{project.name.trim().charAt(0).toUpperCase()}</span>
          <div className="ov-head__b">
            <h3 className="details__title">{project.name}</h3>
            <p className="ov-audience">{audienceLine(people, me.user.id, project.visibility === 'workspace')}</p>
          </div>
        </header>
      </> : <>
        {/* A thread's or a message's Details name it and the space (#266). */}
        <p className="details__eyebrow">{project.name}{conversation && !messageMode ? ' · Conversation' : ''}</p>
        <div className="ov-head ov-head--plain"><h3 className="details__title">{title}</h3></div>
        {message ? <p className="details__lead ov-quote">{message.body.length > 280 ? `${message.body.slice(0, 279)}…` : message.body}</p> : null}
      </>}
      <Rows label={messageMode ? 'Made from this message' : 'Linked in this conversation'} rows={linked}
        controls={read.objects.phase !== 'idle' ? <>
          {read.objects.phase === 'unavailable' ? <p className="wd-error" role="alert">Linked objects could not be loaded. <button type="button" className="ui-link" onClick={read.refreshObjects}>Refresh linked objects</button></p> : null}
          {/* One page is not paginated (#512, AC-6). */}
          {multiPage(read.page) ? <WorkPagination page={read.page} busy={read.objectBusy} label="Overview object pages" onCursor={read.moveObjects} onRefresh={read.refreshObjects} /> : null}
        </> : undefined}
        empty={read.page?.total === 0 ? 'Nothing linked yet. Any message can become a task, a decision or a result.' : read.page && !rows.length ? 'No linked objects on this page. Return to the previous page or refresh.' : undefined} />
      {rows.length ? <div className="ov-relations">
        <p className="ov-note">Sources, thoughts and Wiki pages linked to the {rows.length} shown {rows.length === 1 ? 'object' : 'objects'}.</p>
        {read.relations.phase === 'unavailable' ? <p className="wd-error" role="alert">Object links could not be loaded. <button type="button" className="ui-link" onClick={read.refreshRelations}>Refresh object links</button></p> : null}
        {multiPage(read.links) ? <WorkPagination page={read.links} busy={read.relationBusy} label="Overview relation pages" noun="links" onCursor={read.moveRelations} onRefresh={read.refreshRelations} /> : null}
      </div> : null}
      <Rows label="Sources" rows={[...sources.values()]} />
      {projectMode ? null : <>
        <Rows label={messageMode ? 'On a map' : 'Maps'} rows={sketchRows} empty={!messageMode && noLinkedContext && sketches?.total === 0 ? <>No maps yet. <Link to={`${base}/map`}>Open the Map</Link> to think out loud together.</> : undefined} />
        {moreSketches ? <p className="ov-more"><Link to={`${base}/map`}>All {sketches.total} maps</Link></p> : null}
        <Rows label="Wiki" rows={[...docRows.values()]} empty={!messageMode && noLinkedContext && docs?.length === 0 ? <>No Wiki pages yet. <Link to={`${base}/docs`}>Open the Wiki</Link> to keep what you learn.</> : undefined} />
        {moreDocs ? <p className="ov-more"><Link to={`${base}/docs`}>All {docs.length} Wiki pages</Link></p> : null}
      </>}

      {/* Who is in the space, in one sentence; the people and the controls to change them are in its settings (F-037). */}
      <section className="details__sec ov-sec" aria-label="Space settings">
        {/* Said only when the space is narrower than the default, everyone in the company (#871). */}
        {project.visibility === 'workspace' ? null : <p className="access__line"><Icon name="lock" size={13} /><span>Only the people added to it can open it.</span></p>}
        {/* F-030 (#655): an encrypted space says so, in one line. */}
        {encrypted ? <p className="access__line" data-encrypted-line=""><Icon name="lock" size={13} /><span>Encrypted space · only people work here, no AI.</span></p> : null}
        <Link className="ov-row" to={`/projects/${project.id}/settings`} onClick={closePanel}>
          <Icon name="people" size={16} className="ov-row__ic" />
          <span className="ov-row__b"><span className="ov-row__t">People and settings</span></span>
          <Icon name="chevron-right" size={16} className="ov-row__go" />
        </Link>
      </section>
      {projectMode ? <Rows label="Connected" rows={connected} /> : !message && project.access === 'manager' ? <p className="ov-more"><Link to={`${base}/github`}>GitHub repositories</Link></p> : null}
    </div>
  );
}
