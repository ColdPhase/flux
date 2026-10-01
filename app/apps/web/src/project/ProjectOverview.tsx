import type { ReactNode } from 'react';
import { Link, useMatches } from 'react-router';
import type { Conversation, Decision, Material, ObjectLink, WorkItem, WorkResult } from '@flux/contracts';
import { Avatar, Icon, type IconName } from '../ui';
import { useShellData } from '../app/data';
import { useShellActions, type DetailsView } from '../app/shellContext';
import { STATUS_LABEL, decisionLine, resultLine } from '../work/format';
import { stateParts } from '../work/inline';
import { ACCESS_LABEL, audienceLine, useProjectShell } from './data';
import { docUrl } from '../docs/api';
import { docsLinking } from '../docs/AddToDoc';

/** The open conversation's loader data, when the Conversation tab is showing one. */
function useOpenConversation(): { conversation: Conversation | null; materials: Material[] } | null {
  const match = useMatches().find((entry) => entry.loaderData && typeof entry.loaderData === 'object' && 'conversation' in entry.loaderData);
  return (match?.loaderData as { conversation: Conversation | null; materials: Material[] } | undefined) ?? null;
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
}

function Rows({ label, rows, empty }: { label: string; rows: Row[]; empty?: ReactNode }) {
  const { openDetails } = useShellActions();
  const id = `ov-${label.toLowerCase().replace(/\W+/g, '-')}`;
  if (!rows.length && !empty) return null;
  return (
    <section className="details__sec ov-sec" aria-labelledby={id}>
      <h4 id={id}>{label}</h4>
      {rows.length ? (
        <ul className="ov-rows">
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
              : <button type="button" className="ov-row" onClick={() => openDetails(row.open)}>{body}</button>}</li>;
          })}
        </ul>
      ) : <p className="ov-empty">{empty}</p>}
    </section>
  );
}

const touches = (links: ObjectLink[], id: string, match: (link: ObjectLink) => boolean) => links.some((link) => link.from.id === id && match(link));

/**
 * Details for a project (#117, direction C "overview"): what the open conversation — or one of
 * its messages — is connected to, each one step away: the current state, linked work, decisions
 * and results, sources, sketches and docs, and exactly who can see it. Nothing here is a
 * permanent panel; it opens with Details, the state line or a message's Details action.
 */
export function ProjectOverview({ messageId, onBack }: { messageId?: string; onBack: () => void }) {
  const shell = useProjectShell();
  const open = useOpenConversation();
  const { me } = useShellData();
  if (!shell) return null;
  const { project, people, work: lists, sketches, docs } = shell;
  const conversation = open?.conversation ?? null;
  const message = messageId ? conversation?.messages.find((item) => item.id === messageId) ?? null : null;
  const base = `/projects/${project.id}`;

  // Linked objects: from this message, or from any message of this conversation.
  const linkedTo = (links: ObjectLink[], id: string) => message
    ? touches(links, id, (link) => link.to.type === 'message' && link.to.id === message.id)
    : conversation ? touches(links, id, (link) => link.to.type === 'message' && link.conversationId === conversation.id) : false;
  const work = lists.work.filter((item) => linkedTo(item.links, item.id));
  const decisions = lists.decisions.filter((item) => linkedTo(item.links, item.id));
  const results = lists.results.filter((item) => linkedTo(item.links, item.id));
  const workRow = (item: WorkItem): Row => ({ key: item.id, icon: 'tasks', kind: 'Work', title: item.title, sub: [STATUS_LABEL[item.status], item.owner?.name, item.parked ? 'parked' : null].filter(Boolean).join(' · '), open: { kind: 'work', id: item.id } });
  const decisionRow = (item: Decision): Row => ({ key: item.id, icon: 'rule', kind: item.status === 'accepted' ? 'Current rule' : item.status === 'proposed' ? 'Proposed decision' : 'Earlier rule', title: item.title, sub: decisionLine(item).split(' · ').slice(1).join(' · ') || undefined, need: item.status === 'proposed' && project.access !== 'viewer', open: { kind: 'decision', id: item.id } });
  const resultRow = (item: WorkResult): Row => ({ key: item.id, icon: 'result', kind: 'Result', title: item.title, sub: resultLine(item), open: { kind: 'result', id: item.id } });
  // What needs the reader first, then rules, work and results.
  const linked = [...decisions.filter((item) => item.status === 'proposed').map(decisionRow), ...decisions.filter((item) => item.status !== 'proposed').map(decisionRow), ...work.map(workRow), ...results.map(resultRow)];
  const linkedIds = new Set(linked.map((row) => row.key));

  // Sources: versions cited by messages here, and materials the linked objects are based on.
  const titles = new Map((open?.materials ?? []).map((material) => [material.materialId, material.title]));
  const sources = new Map<string, Row>();
  for (const item of message ? [message] : conversation?.messages ?? []) {
    if (!item.source) continue;
    const key = `${item.source.materialId}:${item.source.version}`;
    sources.set(key, { key, icon: 'doc', kind: `Source · v${item.source.version}`, title: titles.get(item.source.materialId) ?? 'Saved material', sub: 'Cited in this conversation', to: `/materials/${item.source.materialId}/versions/${item.source.version}` });
  }
  const thoughts = new Map<string, Row>();
  for (const object of [...work, ...decisions, ...results]) {
    for (const link of object.links) {
      if (link.to.type === 'material') {
        const key = `${link.to.id}:${link.to.version}`;
        if (!sources.has(key)) sources.set(key, { key, icon: 'doc', kind: `Source · v${link.to.version}`, title: link.toTitle, sub: `Used by “${object.title}”`, to: `/materials/${link.to.id}/versions/${link.to.version}` });
      }
      if (link.to.type === 'thought' && link.sketchId && !thoughts.has(link.to.id)) {
        thoughts.set(link.to.id, { key: link.to.id, icon: 'map', kind: 'Thought on a sketch', title: link.toTitle, sub: `Linked to “${object.title}”`, to: `${base}/map/${link.sketchId}` });
      }
    }
  }
  const sketchRows: Row[] = [...thoughts.values(), ...(message ? [] : (sketches?.items ?? []).slice(0, 3).map((sketch) => ({ key: sketch.id, icon: 'map' as const, kind: 'Sketch', title: sketch.title, sub: `Started by ${sketch.createdBy.id === me.user.id ? 'you' : sketch.createdBy.name}`, to: `${base}/map/${sketch.id}` })))];
  const moreSketches = !message && sketches && sketches.total > 3;

  // Docs that include or mention what is linked here, then the project's latest docs.
  const docRows = new Map<string, Row>();
  for (const object of [...decisions, ...results]) {
    for (const doc of docsLinking(object.links, object.id)) {
      if (!docRows.has(doc.id)) docRows.set(doc.id, { key: doc.id, icon: 'doc', kind: doc.role === 'source' ? 'Doc · includes it' : 'Doc · mentions it', title: doc.title, sub: `“${object.title}”`, to: docUrl(project.id, doc.id) });
    }
  }
  if (!message) for (const doc of (docs ?? []).slice(0, 3)) {
    if (!docRows.has(doc.id)) docRows.set(doc.id, { key: doc.id, icon: 'doc', kind: doc.state === 'draft' ? 'Doc · draft' : 'Doc', title: doc.title, sub: `Changed by ${doc.updatedBy.id === me.user.id ? 'you' : doc.updatedBy.name}${doc.reason ? ` · ${doc.reason}` : ''}`, to: docUrl(project.id, doc.id) });
  }
  const moreDocs = !message && docs && docs.length > 3;

  // The project's current state, without repeating what is already linked here.
  const state = message ? [] : stateParts(lists, project.access !== 'viewer').filter((part) => !linkedIds.has(part.open.id)).map((part): Row => ({
    key: part.key, icon: part.icon ?? (part.key === 'work' ? 'tasks' : 'rule'), kind: part.key === 'rule' ? 'Current rule' : part.key === 'result' ? 'Latest result' : part.key === 'proposal' ? 'Proposed decision' : part.key === 'blocked' ? 'Blocked' : 'In progress',
    title: part.title, need: part.tone === 'need', sub: part.tone === 'need' ? 'Needs you' : undefined, open: part.open,
  }));
  const author = message ? (message.authorId === null ? `${message.author.name ?? 'Agent'} · agent` : message.authorId === me.user.id ? 'you' : people?.find((person) => person.id === message.authorId)?.name ?? 'a member') : null;
  const title = message ? `Message from ${author}` : conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  const others = (people ?? []).filter((person) => !(person.kind === 'human' && person.id === me.user.id));

  return (
    <div className="details ov">
      {message ? <button type="button" className="details__back" onClick={onBack}><Icon name="chevron-left" size={14} />{conversation ? 'This conversation' : 'Project'}</button> : null}
      <p className="details__eyebrow">{project.name}{conversation && !message ? ' · Conversation' : ''}</p>
      <h3 className="details__title">{title}</h3>
      {message ? <p className="details__lead ov-quote">{message.body.length > 280 ? `${message.body.slice(0, 279)}…` : message.body}</p> : null}
      <p className="ov-audience"><Icon name="lock" size={13} />{audienceLine(people, me.user.id)}</p>

      <Rows label={message ? 'Made from this message' : 'Linked in this conversation'} rows={linked}
        empty={conversation ? (project.access !== 'viewer' ? 'Nothing linked yet. Any message can become work, a decision or a result.' : 'Nothing linked yet.') : undefined} />
      {state.length ? <Rows label={conversation ? 'Elsewhere in this project' : 'Now in this project'} rows={state} /> : null}
      <Rows label="Sources" rows={[...sources.values()]} />
      <Rows label={message ? 'On a sketch' : 'Sketches'} rows={sketchRows} empty={message ? undefined : <>No sketches yet. <Link to={`${base}/map`}>Open the Map</Link> to think out loud together.</>} />
      {moreSketches ? <p className="ov-more"><Link to={`${base}/map`}>All {sketches.total} sketches</Link></p> : null}
      <Rows label="Docs" rows={[...docRows.values()]} empty={message ? undefined : <>No docs yet. <Link to={`${base}/docs`}>Open Docs</Link> to keep what you learn.</>} />
      {moreDocs ? <p className="ov-more"><Link to={`${base}/docs`}>All {docs.length} docs</Link></p> : null}

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
