import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { DecisionRowProjection, NamedPrincipal, NativeWorkRow, WorkReadRef, WorkRowProjection, WorkStatus, ResultRowProjection } from '@flux/contracts';
import { AgentIdentity, Icon, MEDIA, StatusGlyph, TASK_STATE_WORD, useMediaQuery, type IconName } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions, type DetailsView, type OverviewView } from '../app/shellContext';
import { STATUS_LABEL, decisionLine } from '../work/format';
import { summaryStateParts, type StatePart } from '../work/state-summary';
import { useProjectWorkSummary } from '../work/WorkReadContext';
import { useOverviewWork } from '../work/useOverviewWork';
import { getWorkReferenceRows } from '../work/read-api';
import { useWorkRead } from '../work/useWorkRead';
import { WorkPagination } from '../work/WorkPagination';
import { audienceLine, useProjectShell } from './data';
import { ProjectAccess } from '../people/ProjectAccess';
import { docUrl } from '../docs/api';
import { useOpenConversation } from './OverviewContext';
import { agentDisplayName, shortDate } from '../docs/format';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import './overview.css';

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

/** What a state line says beyond its kind and title: the title, and the kind's own words, are not said twice (#512, AC-3). */
function stateSub(part: StatePart): string | undefined {
  if (part.key === 'rule') return undefined;
  if (part.key === 'result') return part.text.startsWith('Negative') ? 'Negative result' : undefined;
  if (part.key === 'work' && part.text.startsWith('Task in progress: ')) return /\(([^)]*)\)$/.exec(part.text)?.[1];
  return part.text;
}

/** A single page of objects has no pager (#512, AC-6); while the page is unread the pager keeps its own loading state. */
const multiPage = (page: { previousCursor: string | null; nextCursor: string | null } | null) => !page || !!page.previousCursor || !!page.nextCursor;

/** One row: its kind, title and sub-line, a count at the right, and where it goes. */
function RowItems({ rows }: { rows: Row[] }) {
  const { openDetails } = useShellActions();
  return (
    <ul className="ov-rows">
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
          ? <Link className="ov-row" to={row.to}>{body}</Link>
          : <button type="button" className="ov-row" data-work-kind={row.native?.kind} data-work-id={row.native?.id} onClick={() => openDetails(row.open)}>{body}</button>}</li>;
      })}
    </ul>
  );
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
                {row.kind ? <span className="ov-row__k">{row.kind}</span> : null}
                <span className="ov-row__t">{row.title}</span>
                {row.sub ? <span className={`ov-row__s${row.need ? ' ws-need' : ''}`}>{row.sub}</span> : null}
              </span>
              {row.end ? <span className="ov-row__n">{row.end}</span> : null}
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

/** The task rows and the rule of the project's "Now" (#512, AC-3): each object once, in one line or one small card. */
interface NowTask { key: string; id: string; status: WorkStatus; title: string }

function NowSection({ projectId, tasks, rule, lines, others }: { projectId: string; tasks: NowTask[]; rule: WorkReadRef | null; lines: Row[]; others: Row[] }) {
  const { me } = useShellData();
  const { openDetails } = useShellActions();
  // The task's number and the rule's date are read for exactly these objects; the rows show at once.
  const refs = [...tasks.map((task) => `work:${task.id}`), ...(rule ? [`decision:${rule.id}`] : [])].sort().join(',');
  const scope = refs ? { accountId: me.user.id, projectId, selector: `now:${refs}` } : null;
  const load = useCallback((signal: AbortSignal) => getWorkReferenceRows(projectId, refs, signal), [projectId, refs]);
  const read = useWorkRead(scope, load);
  const items = read.phase === 'ready' || read.phase === 'refreshing' ? read.value.items : [];
  const numberOf = (id: string) => { const row = items.find((item) => item.kind === 'work' && item.id === id); return row?.kind === 'work' ? `#${row.number}` : ''; };
  const accepted = rule ? items.find((item): item is DecisionRowProjection => item.kind === 'decision' && item.id === rule.id)?.decidedAt ?? null : null;
  if (!tasks.length && !rule && !lines.length && !others.length) return null;
  return (
    <section className="details__sec ov-sec" aria-labelledby="ov-now">
      <h4 id="ov-now">Now</h4>
      {tasks.length || lines.length ? (
        <ul className="ov-rows ov-lines">
          {tasks.map((task) => (
            <li key={task.key}>
              <button type="button" className="ov-line" onClick={() => openDetails({ kind: 'work', id: task.id })}>
                <StatusGlyph status={task.status} size={16} className="ov-line__g" />
                <span className="ov-line__t" title={task.title}><span className="ui-vh">{TASK_STATE_WORD[task.status]}: </span>{task.title}</span>
                <span className="ov-line__n">{numberOf(task.id)}</span>
              </button>
            </li>
          ))}
          {lines.map((row) => (
            <li key={row.key}>
              <button type="button" className="ov-line" onClick={() => openDetails(row.open)}>
                <Icon name={row.icon} size={16} className="ov-line__g" />
                <span className="ov-line__t" title={row.title}><span className="ui-vh">{row.kind}: </span>{row.title}</span>
                <span className={`ov-line__n${row.need ? ' ws-need' : ''}`}>{row.end}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length ? <RowItems rows={others} /> : null}
      {rule ? (
        <button type="button" className="ov-rule" onClick={() => openDetails({ kind: 'decision', id: rule.id })}>
          <span className="ov-rule__k"><Icon name="rule" size={13} />Current rule{accepted ? <> · accepted {shortDate(accepted)}</> : null}</span>
          <span className="ov-rule__t">{rule.title}</span>
        </button>
      ) : null}
    </section>
  );
}

/**
 * Details for a project (#117, direction C "overview"): what the open conversation — or one of
 * its messages — is connected to, each one step away: the current state, linked work, decisions
 * and results, sources, sketches and docs, and exactly who can see it. Nothing here is a
 * permanent panel; it opens with Details, the state line or a message's Details action.
 */
export function ProjectOverview({ messageId, selection, focusPeople = null, onBack }: { messageId?: string; selection?: OverviewView['selection']; focusPeople?: object | null; onBack: () => void }) {
  const shell = useProjectShell();
  const open = useOpenConversation();
  const { me, workspaces } = useShellData();
  const { openDetails } = useShellActions();
  const phone = useMediaQuery(MEDIA.navDrawer);
  const read = useOverviewWork(me.user.id, shell?.project.id ?? null, open?.conversation?.id ?? null, messageId);
  const current = useProjectWorkSummary();
  const owners = useAgentOwners(shell?.project);
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
  const stateParts = messageMode || !current.summary ? [] : summaryStateParts(current.summary, current.summary.access !== 'viewer');
  const aggregateKeys = new Set(['work', 'blocked', 'open', 'history']);
  const totalsByTarget = new Map(stateParts.filter((part) => aggregateKeys.has(part.key)).map((part) => [`${part.open.kind}:${part.open.id}`, part]));
  const withProjectTotal = (row: Row): Row => {
    const part = totalsByTarget.get(row.key);
    return part ? { ...row, sub: dotted([row.sub, `In this project: ${part.text}`]) } : row;
  };
  const work = rows.filter((item): item is WorkRowProjection => item.kind === 'work');
  const decisions = rows.filter((item): item is DecisionRowProjection => item.kind === 'decision');
  const results = rows.filter((item): item is ResultRowProjection => item.kind === 'result');
  const workRow = (item: WorkRowProjection): Row => ({ key: `work:${item.id}`, native: item, icon: 'tasks', kind: 'Work', title: item.title, sub: dotted([STATUS_LABEL[item.status], item.owner ? byline(item.owner) : null, item.parked ? 'parked' : null]), open: { kind: 'work', id: item.id } });
  const decisionRow = (item: DecisionRowProjection): Row => ({ key: `decision:${item.id}`, native: item, icon: 'rule', kind: item.status === 'accepted' ? 'Current rule' : item.status === 'proposed' ? 'Proposed decision' : 'Earlier rule', title: item.title, sub: decisionLine(item).split(' · ').slice(1).join(' · ') || undefined, need: item.status === 'proposed' && project.access !== 'viewer', open: { kind: 'decision', id: item.id } });
  const resultRow = (item: ResultRowProjection): Row => ({ key: `result:${item.id}`, native: item, icon: 'result', kind: 'Result', title: item.title, sub: dotted([`${item.finding === 'negative' ? 'Negative' : 'Positive'} result`, byline(item.createdBy)]), open: { kind: 'result', id: item.id } });
  const linked = [...decisions.filter((item) => item.status === 'proposed').map(decisionRow), ...decisions.filter((item) => item.status !== 'proposed').map(decisionRow), ...work.map(workRow), ...results.map(resultRow)].map(withProjectTotal);
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
  const sketchRows: Row[] = [...thoughts.values(), ...(messageMode ? [] : (sketches?.items ?? []).slice(0, 3).map((sketch) => ({ key: sketch.id, icon: 'map' as const, kind: 'Sketch', title: sketch.title, sub: <>Started by {sketch.createdBy.id === me.user.id ? 'you' : byline(sketch.createdBy)}</>, to: `${base}/map/${sketch.id}` })))];
  const moreSketches = !messageMode && sketches && sketches.total > 3;

  // Docs that include or mention what is linked here, then the project's latest docs.
  const docRows = new Map<string, Row>();
  for (const link of relationItems) {
    if (link.from.type !== 'doc' || (link.to.type !== 'decision' && link.to.type !== 'result')) continue;
    const object = byRef.get(`${link.to.type}:${link.to.id}`);
    if (object && (!docRows.has(link.from.id) || link.role === 'source')) docRows.set(link.from.id, { key: link.from.id, icon: 'doc', kind: link.role === 'source' ? 'Doc · includes it' : 'Doc · mentions it', title: link.fromTitle, sub: `“${object.title}”`, to: docUrl(project.id, link.from.id) });
  }
  if (!messageMode) for (const doc of (docs ?? []).slice(0, 3)) {
    if (!docRows.has(doc.id)) docRows.set(doc.id, { key: doc.id, icon: 'doc', kind: doc.state === 'draft' ? 'Doc · draft' : 'Doc', title: doc.title, sub: dotted([<>Changed by {doc.updatedBy.kind === 'human' && doc.updatedBy.id === me.user.id ? 'you' : byline(doc.updatedBy)}</>, doc.reason]), to: docUrl(project.id, doc.id) });
  }
  const moreDocs = !messageMode && docs && docs.length > 3;
  const noLinkedContext = read.objects.phase === 'idle' || read.page && (read.page.total === 0
    || read.page.total === rows.length && read.links?.total === 0);

  // The project's current state, without repeating what is already linked here.
  const state = stateParts.filter((part) => !linkedIds.has(`${part.open.kind}:${part.open.id}`)).map((part): Row => ({
    key: part.key, icon: part.icon ?? (part.key === 'work' ? 'tasks' : 'rule'), kind: part.key === 'rule' ? 'Current rule' : part.key === 'result' ? 'Latest result' : part.key === 'proposal' ? 'Proposed decision' : part.key === 'blocked' ? 'Blocked' : part.key === 'open' ? 'Open task' : part.key === 'history' ? (part.open.kind === 'work' ? 'Earlier work' : 'Earlier decision') : 'In progress',
    title: part.title, need: part.tone === 'need', sub: stateSub(part), open: part.open,
  }));
  // "Now" in the project's own Details (#512, AC-3): its blocked, in-progress and open tasks, the rule once, and what needs a look.
  const summaryState = projectMode ? current.summary?.state ?? null : null;
  const nowTasks: NowTask[] = [];
  if (summaryState?.blocked.first) nowTasks.push({ key: 'blocked', id: summaryState.blocked.first.id, status: 'blocked', title: summaryState.blocked.first.title });
  if (summaryState?.active.first) nowTasks.push({ key: 'active', id: summaryState.active.first.id, status: 'in_progress', title: summaryState.active.first.title });
  if (summaryState?.open.first) nowTasks.push({ key: 'open', id: summaryState.open.first.id, status: 'open', title: summaryState.open.first.title });
  // A proposed decision and the latest result are one line each; with nothing else going on, the earlier work is a short row.
  const nowLines: Row[] = projectMode ? stateParts.filter((part) => part.key === 'proposal' || part.key === 'result').map((part): Row => ({
    key: part.key, icon: part.key === 'result' ? 'result' : 'rule', kind: part.key === 'result' ? 'Latest result' : 'Proposed decision', title: part.title,
    end: part.key === 'result' ? (part.text.startsWith('Negative') ? 'Negative result' : 'Result') : part.tone === 'need' ? 'Needs you' : 'Proposed', need: part.tone === 'need', open: part.open,
  })) : [];
  const nowOthers: Row[] = projectMode ? state.filter((row) => row.key === 'history') : [];
  const count = (n: number | undefined, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : undefined);
  const inProject: Row[] = projectMode ? [
    { key: 'in-map', icon: 'map', kind: '', title: 'Map', end: count(sketches?.total, 'sketch', 'sketches'), to: `${base}/map` },
    { key: 'in-wiki', icon: 'doc', kind: '', title: 'Wiki', end: count(docs?.length, 'page', 'pages'), to: `${base}/docs` },
    { key: 'in-tasks', icon: 'tasks', kind: '', title: 'Tasks', end: current.summary?.unfinishedTotal ? `${current.summary.unfinishedTotal} open` : undefined, to: `${base}/tasks` },
  ] : [];
  const connected: Row[] = projectMode && project.access === 'manager' ? [{ key: 'github', icon: 'link', kind: '', title: 'GitHub repositories', to: `${base}/github` }] : [];
  const space = workspaces.find((item) => item.id === project.workspaceId);
  const author: ReactNode = message ? (message.authorId === null
    ? <AgentIdentity name={agentDisplayName(message.author)} owner={agentAuthorOwner(message.author, owners)} icon={14} />
    : message.authorId === me.user.id ? 'you' : people?.find((person) => person.id === message.authorId)?.name ?? 'a member') : null;
  const title: ReactNode = messageMode ? message ? <>Message from {author}</> : 'Message' : conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;

  return (
    <div className={`details ov${projectMode ? ' ov--project' : ''}`} data-overview-phase={read.objects.phase} data-overview-observed-at={read.page?.observedAt} data-overview-relations-phase={read.relations.phase} data-overview-relations-observed-at={read.links?.observedAt}>
      {messageMode ? <button type="button" className="details__back" onClick={onBack}><Icon name="chevron-left" size={14} />{conversation ? 'This conversation' : 'Project'}</button> : null}
      {projectMode ? (
        // The project itself, once: its tile and name, then who is in it and its space (#512, AC-2).
        <header className="ov-head">
          <span className="ov-tile" aria-hidden="true">{project.name.trim().charAt(0).toUpperCase()}</span>
          <div className="ov-head__b">
            <h3 className="details__title">{project.name}</h3>
            <p className="ov-audience">{audienceLine(people, me.user.id, project.visibility === 'workspace')}{space ? <> · {space.name}</> : null}</p>
          </div>
        </header>
      ) : <>
        {/* A thread's or a message's Details name it and the project (#266). */}
        <p className="details__eyebrow">{project.name}{conversation && !messageMode ? ' · Conversation' : ''}</p>
        <h3 className="details__title">{title}</h3>
        {message ? <p className="details__lead ov-quote">{message.body.length > 280 ? `${message.body.slice(0, 279)}…` : message.body}</p> : null}
        <p className="ov-audience"><Icon name={project.visibility === 'workspace' ? 'people' : 'lock'} size={13} />{audienceLine(people, me.user.id, project.visibility === 'workspace')}</p>
      </>}
      {phone && !messageMode ? <section className="details__sec ov-sec" aria-label="Project summary">
        <button type="button" className="ov-row" onClick={() => openDetails({ kind: 'recap', projectId: project.id })}>
          <Icon name="leaf" size={16} className="ov-row__ic" />
          <span className="ov-row__b"><span className="ov-row__t">What matters</span></span>
          <Icon name="chevron-right" size={16} className="ov-row__go" />
        </button>
      </section> : null}

      <Rows label={messageMode ? 'Made from this message' : 'Linked in this conversation'} rows={linked}
        controls={read.objects.phase !== 'idle' ? <>
          {read.objects.phase === 'unavailable' ? <p className="wd-error" role="alert">Linked objects could not be loaded. <button type="button" className="ui-link" onClick={read.refreshObjects}>Refresh linked objects</button></p> : null}
          {/* One page is not paginated (#512, AC-6). */}
          {multiPage(read.page) ? <WorkPagination page={read.page} busy={read.objectBusy} label="Overview object pages" onCursor={read.moveObjects} onRefresh={read.refreshObjects} /> : null}
        </> : undefined}
        empty={read.page?.total === 0 ? (project.access !== 'viewer' ? 'Nothing linked yet. Any message can become work, a decision or a result.' : 'Nothing linked yet.') : read.page && !rows.length ? 'No linked objects on this page. Return to the previous page or refresh.' : undefined} />
      {projectMode
        ? <NowSection projectId={project.id} tasks={nowTasks} rule={summaryState?.rule ?? null} lines={nowLines} others={nowOthers} />
        : state.length ? <Rows label={conversation ? 'Elsewhere in this project' : 'Now in this project'} rows={state} /> : null}
      {!messageMode && !current.summary ? <p className="ov-empty" role="status">{current.phase === 'unavailable' ? 'Current work unavailable.' : 'Loading current work…'}</p> : null}
      {rows.length ? <div className="ov-relations">
        <p className="ov-note">Sources, thoughts and docs linked to the {rows.length} shown {rows.length === 1 ? 'object' : 'objects'}.</p>
        {read.relations.phase === 'unavailable' ? <p className="wd-error" role="alert">Object links could not be loaded. <button type="button" className="ui-link" onClick={read.refreshRelations}>Refresh object links</button></p> : null}
        {multiPage(read.links) ? <WorkPagination page={read.links} busy={read.relationBusy} label="Overview relation pages" noun="links" onCursor={read.moveRelations} onRefresh={read.refreshRelations} /> : null}
      </div> : null}
      <Rows label="Sources" rows={[...sources.values()]} />
      {projectMode ? <Rows label="In this project" rows={inProject} /> : <>
        <Rows label={messageMode ? 'On a sketch' : 'Sketches'} rows={sketchRows} empty={!messageMode && noLinkedContext && sketches?.total === 0 ? <>No sketches yet. <Link to={`${base}/map`}>Open the Map</Link> {project.access === 'viewer' ? 'to browse saved sketches.' : 'to think out loud together.'}</> : undefined} />
        {moreSketches ? <p className="ov-more"><Link to={`${base}/map`}>All {sketches.total} sketches</Link></p> : null}
        <Rows label="Docs" rows={[...docRows.values()]} empty={!messageMode && noLinkedContext && docs?.length === 0 ? <>No docs yet. <Link to={`${base}/docs`}>Open Docs</Link> {project.access === 'viewer' ? 'to read saved documents.' : 'to keep what you learn.'}</> : undefined} />
        {moreDocs ? <p className="ov-more"><Link to={`${base}/docs`}>All {docs.length} docs</Link></p> : null}
      </>}

      {/* Exactly who can open it, and for its managers the controls to change that (#188). */}
      <ProjectAccess project={project} people={people} focusToken={focusPeople} />
      {projectMode ? <Rows label="Connected" rows={connected} /> : !message && project.access === 'manager' ? <p className="ov-more"><Link to={`${base}/github`}>GitHub repositories</Link></p> : null}
    </div>
  );
}
