import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useMatches } from 'react-router';
import type { Conversation, DecisionRowProjection, Material, NativeWorkRow, WorkRowProjection, ResultRowProjection } from '@flux/contracts';
import { Avatar, Icon, type IconName } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions, type DetailsView, type OverviewView } from '../app/shellContext';
import { STATUS_LABEL, decisionLine, resultLine } from '../work/format';
import { summaryStateParts } from '../work/state-summary';
import { useProjectWorkSummary } from '../work/WorkReadContext';
import { useOverviewWork } from '../work/useOverviewWork';
import { WorkPagination } from '../work/WorkPagination';
import { ACCESS_LABEL, audienceLine, useProjectShell } from './data';
import { docUrl } from '../docs/api';
import { docsLinking } from '../docs/AddToDoc';
import { authorLabel } from '../docs/format';

/** The open conversation's loader data, when the Conversation tab is showing one. */
function useOpenConversation(): { conversation: Conversation | null; materials: Material[] } | null {
  const match = useMatches().find((entry) => entry.loaderData && typeof entry.loaderData === 'object' && 'conversation' in entry.loaderData);
  return (match?.loaderData as { conversation: Conversation | null; materials: Material[] } | undefined) ?? null;
}

/** The owning context stays visible when a phone reader scrolls down to sources. */
export function OverviewContext() {
  const shell = useProjectShell();
  const open = useOpenConversation();
  const { me } = useShellData();
  if (!shell) return null;
  const title = open?.conversation?.firstMessageBody.split('\n')[0];
  return <div className="ov-panel-context" aria-label="Overview context">
    <strong>{shell.project.name}</strong>
    {title ? <span title={title}>{title}</span> : null}
    <small><Icon name="lock" size={11} />{audienceLine(shell.people, me.user.id)}</small>
  </div>;
}

interface Row {
  key: string;
  icon: IconName;
  kind: string;
  title: string;
  sub?: string;
  need?: boolean;
  open?: DetailsView;
  to?: string;
  native?: { kind: NativeWorkRow['kind']; id: string };
}

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
                <span className="ov-row__k">{row.kind}</span>
                <span className="ov-row__t">{row.title}</span>
                {row.sub ? <span className={`ov-row__s${row.need ? ' ws-need' : ''}`}>{row.sub}</span> : null}
              </span>
              <Icon name="chevron-right" size={16} className="ov-row__go" />
            </>;
            return <li key={row.key}>{row.to
              ? <Link className="ov-row" to={row.to}>{body}</Link>
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
  const read = useOverviewWork(me.user.id, shell?.project.id ?? null, open?.conversation?.id ?? null, messageId);
  const current = useProjectWorkSummary();
  if (!shell) return null;
  const { project, people, sketches, docs } = shell;
  const conversation = open?.conversation ?? null;
  // Older messages loaded by the feed are absent from the route's latest-message window.
  // Keep exactly the selected native message, scoped to its reader/project/conversation,
  // and expose it only after the current native association read verifies that source.
  const selected = selection?.accountId === me.user.id && selection.projectId === project.id
    && selection.message.id === messageId && selection.message.conversationId === conversation?.id
    ? selection.message : null;
  const message = messageId && read.page ? conversation?.messages.find((item) => item.id === messageId) ?? selected : null;
  const messageMode = !!messageId;
  const base = `/projects/${project.id}`;

  // One native row window for every matching role, including Related-only objects.
  // Conversation scope covers all native messages, independently of its source-count window.
  const rows = read.page?.items ?? [];
  const work = rows.filter((item): item is WorkRowProjection => item.kind === 'work');
  const decisions = rows.filter((item): item is DecisionRowProjection => item.kind === 'decision');
  const results = rows.filter((item): item is ResultRowProjection => item.kind === 'result');
  const workRow = (item: WorkRowProjection): Row => ({ key: `work:${item.id}`, native: item, icon: 'tasks', kind: 'Work', title: item.title, sub: [STATUS_LABEL[item.status], item.owner?.name, item.parked ? 'parked' : null].filter(Boolean).join(' · '), open: { kind: 'work', id: item.id } });
  const decisionRow = (item: DecisionRowProjection): Row => ({ key: `decision:${item.id}`, native: item, icon: 'rule', kind: item.status === 'accepted' ? 'Current rule' : item.status === 'proposed' ? 'Proposed decision' : 'Earlier rule', title: item.title, sub: decisionLine(item).split(' · ').slice(1).join(' · ') || undefined, need: item.status === 'proposed' && project.access !== 'viewer', open: { kind: 'decision', id: item.id } });
  const resultRow = (item: ResultRowProjection): Row => ({ key: `result:${item.id}`, native: item, icon: 'result', kind: 'Result', title: item.title, sub: resultLine(item), open: { kind: 'result', id: item.id } });
  const linked = [...decisions.filter((item) => item.status === 'proposed').map(decisionRow), ...decisions.filter((item) => item.status !== 'proposed').map(decisionRow), ...work.map(workRow), ...results.map(resultRow)];
  const linkedIds = new Set(linked.map((row) => row.key));
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
      thoughts.set(link.to.id, { key: link.to.id, icon: 'map', kind: 'Thought on a sketch', title: link.toTitle, sub: `Linked to “${object.title}”`, to: `${base}/map/${link.sketchId}#thought-${link.to.id}` });
    }
  }
  const sketchRows: Row[] = [...thoughts.values(), ...(messageMode ? [] : (sketches?.items ?? []).slice(0, 3).map((sketch) => ({ key: sketch.id, icon: 'map' as const, kind: 'Sketch', title: sketch.title, sub: `Started by ${sketch.createdBy.id === me.user.id ? 'you' : sketch.createdBy.name}`, to: `${base}/map/${sketch.id}` })))];
  const moreSketches = !messageMode && sketches && sketches.total > 3;

  // Docs that include or mention what is linked here, then the project's latest docs.
  const docRows = new Map<string, Row>();
  for (const link of relationItems) {
    if (link.from.type !== 'doc' || (link.to.type !== 'decision' && link.to.type !== 'result')) continue;
    const object = byRef.get(`${link.to.type}:${link.to.id}`);
    if (object && (!docRows.has(link.from.id) || link.role === 'source')) docRows.set(link.from.id, { key: link.from.id, icon: 'doc', kind: link.role === 'source' ? 'Doc · includes it' : 'Doc · mentions it', title: link.fromTitle, sub: `“${object.title}”`, to: docUrl(project.id, link.from.id) });
  }
  if (!messageMode) for (const doc of (docs ?? []).slice(0, 3)) {
    if (!docRows.has(doc.id)) docRows.set(doc.id, { key: doc.id, icon: 'doc', kind: doc.state === 'draft' ? 'Doc · draft' : 'Doc', title: doc.title, sub: `Changed by ${doc.updatedBy.kind === 'human' && doc.updatedBy.id === me.user.id ? 'you' : authorLabel(doc.updatedBy)}${doc.reason ? ` · ${doc.reason}` : ''}`, to: docUrl(project.id, doc.id) });
  }
  const moreDocs = !messageMode && docs && docs.length > 3;
  const noLinkedContext = read.objects.phase === 'idle' || read.page && (read.page.total === 0
    || read.page.total === rows.length && read.links?.total === 0);

  // The project's current state, without repeating what is already linked here.
  const state = messageMode || !current.summary ? [] : summaryStateParts(current.summary, current.summary.access !== 'viewer').filter((part) => !linkedIds.has(`${part.open.kind}:${part.open.id}`)).map((part): Row => ({
    key: part.key, icon: part.icon ?? (part.key === 'work' ? 'tasks' : 'rule'), kind: part.key === 'rule' ? 'Current rule' : part.key === 'result' ? 'Latest result' : part.key === 'proposal' ? 'Proposed decision' : part.key === 'blocked' ? 'Blocked' : part.key === 'open' ? 'Open task' : part.key === 'history' ? (part.open.kind === 'work' ? 'Earlier work' : 'Earlier decision') : 'In progress',
    title: part.title, need: part.tone === 'need', sub: part.tone === 'need' ? 'Needs you' : undefined, open: part.open,
  }));
  const author = message ? (message.authorId === null ? `${message.author.name ?? 'Agent'} · agent` : message.authorId === me.user.id ? 'you' : people?.find((person) => person.id === message.authorId)?.name ?? 'a member') : null;
  const title = messageMode ? message ? `Message from ${author}` : 'Message' : conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  const others = (people ?? []).filter((person) => !(person.kind === 'human' && person.id === me.user.id));

  return (
    <div className="details ov" data-overview-phase={read.objects.phase} data-overview-observed-at={read.page?.observedAt} data-overview-relations-phase={read.relations.phase} data-overview-relations-observed-at={read.links?.observedAt}>
      {messageMode ? <button type="button" className="details__back" onClick={onBack}><Icon name="chevron-left" size={14} />{conversation ? 'This conversation' : 'Project'}</button> : null}
      <p className="details__eyebrow">{project.name}{conversation && !messageMode ? ' · Conversation' : ''}</p>
      <h3 className="details__title">{title}</h3>
      {message ? <p className="details__lead ov-quote">{message.body.length > 280 ? `${message.body.slice(0, 279)}…` : message.body}</p> : null}
      <p className="ov-audience"><Icon name="lock" size={13} />{audienceLine(people, me.user.id)}</p>

      <Rows label={messageMode ? 'Made from this message' : 'Linked in this conversation'} rows={linked}
        controls={read.objects.phase !== 'idle' ? <>
          {read.objects.phase === 'unavailable' ? <p className="wd-error" role="alert">Linked objects could not be loaded. <button type="button" className="ui-link" onClick={read.refreshObjects}>Refresh linked objects</button></p> : null}
          <WorkPagination page={read.page} busy={read.objectBusy} label="Overview object pages" onCursor={read.moveObjects} onRefresh={read.refreshObjects} />
        </> : undefined}
        empty={read.page?.total === 0 ? (project.access !== 'viewer' ? 'Nothing linked yet. Any message can become work, a decision or a result.' : 'Nothing linked yet.') : read.page && !rows.length ? 'No linked objects on this page. Return to the previous page or refresh.' : undefined} />
      {state.length ? <Rows label={conversation ? 'Elsewhere in this project' : 'Now in this project'} rows={state} /> : null}
      {!messageMode && !current.summary ? <p className="ov-empty" role="status">{current.phase === 'unavailable' ? 'Current work unavailable.' : 'Loading current work…'}</p> : null}
      {rows.length ? <div className="ov-relations">
        <p className="ov-note">Sources, thoughts and docs linked to the {rows.length} shown {rows.length === 1 ? 'object' : 'objects'}.</p>
        {read.relations.phase === 'unavailable' ? <p className="wd-error" role="alert">Object links could not be loaded. <button type="button" className="ui-link" onClick={read.refreshRelations}>Refresh object links</button></p> : null}
        <WorkPagination page={read.links} busy={read.relationBusy} label="Overview relation pages" noun="links" onCursor={read.moveRelations} onRefresh={read.refreshRelations} />
      </div> : null}
      <Rows label="Sources" rows={[...sources.values()]} />
      <Rows label={messageMode ? 'On a sketch' : 'Sketches'} rows={sketchRows} empty={!messageMode && noLinkedContext && sketches?.total === 0 ? <>No sketches yet. <Link to={`${base}/map`}>Open the Map</Link> {project.access === 'viewer' ? 'to browse saved sketches.' : 'to think out loud together.'}</> : undefined} />
      {moreSketches ? <p className="ov-more"><Link to={`${base}/map`}>All {sketches.total} sketches</Link></p> : null}
      <Rows label="Docs" rows={[...docRows.values()]} empty={!messageMode && noLinkedContext && docs?.length === 0 ? <>No docs yet. <Link to={`${base}/docs`}>Open Docs</Link> {project.access === 'viewer' ? 'to read saved documents.' : 'to keep what you learn.'}</> : undefined} />
      {moreDocs ? <p className="ov-more"><Link to={`${base}/docs`}>All {docs.length} docs</Link></p> : null}

      {!message && project.access === 'manager' ? <p className="ov-more"><Link to={`${base}/github`}>GitHub repositories</Link></p> : null}
      <section className="details__sec" aria-labelledby="ov-people">
        <h4 id="ov-people">Who can see this</h4>
        {people ? (
          <ul className="details__rows">
            <li className="details__person"><Avatar name={me.user.name} size="md" tone="me" /><b>{me.user.name} (you)</b></li>
            {others.map((person) => <li key={`${person.kind}:${person.id}`} className="details__person"><Avatar name={person.name} size="md" /><span className="ov-person"><b>{person.name}{person.kind === 'agent' ? ' (agent)' : ''}</b><span>{ACCESS_LABEL[person.access]}</span></span></li>)}
          </ul>
        ) : <p>Everyone with access to {project.name}.</p>}
        <p className="ov-note">Direct messages with these people stay private; nothing in them is shared with this project.</p>
      </section>
      <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
    </div>
  );
}
