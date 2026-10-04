import { useCallback, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { ConversationMessage, Project, ProjectWorkSummary } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Icon, useMediaQuery } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { createWork, type ProjectWork } from './api';
import { decisionLine, firstLine, resultLine, workLine } from './format';
import type { MessageWorkPreview } from './message-associations';
import { summaryEmptyCaption, summaryStateParts, type StatePart } from './state-summary';
import './work.css';

// Work objects inside the conversation (#101, C direction): the calm state line under the
// header, the quiet actions of a message and the framed objects that were made from it.

/** One part of the project's current state: what it says and the object it opens. */
export type { StatePart } from './state-summary';

/**
 * The project's current state from real records: the rule in force, work in progress, blocked
 * work, the latest result and a proposal waiting for a person (#101, #117).
 */
export function stateParts(lists: ProjectWork, canDecide: boolean): StatePart[] {
  const rule = lists.decisions.find((decision) => decision.status === 'accepted');
  const proposal = lists.decisions.find((decision) => decision.status === 'proposed');
  const active = lists.work.filter((item) => item.status === 'in_progress' && !item.parked);
  const blocked = lists.work.filter((item) => item.status === 'blocked' && !item.parked);
  const open = lists.work.filter((item) => item.status === 'open' && !item.parked);
  const result = [...lists.results].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const parts: StatePart[] = [];
  if (rule) parts.push({ key: 'rule', icon: 'rule', text: `Current rule: ${rule.title}`, short: `Rule: ${rule.title}`, title: rule.title, open: { kind: 'decision', id: rule.id } });
  if (active.length) {
    const names = [...new Set(active.map((item) => item.owner?.name.trim().split(/\s+/)[0]).filter(Boolean))];
    const who = names.length ? ` (${names.join(', ')})` : '';
    parts.push({ key: 'work', icon: null, dot: 'progress', text: `${active.length === 1 ? `In progress: ${active[0]!.title}` : `${active.length} in progress`}${who}`, short: `Work in progress${who}`, title: active.length === 1 ? `${active[0]!.title}${who}` : `${active.length} items in progress${who}`, open: { kind: 'work', id: active[0]!.id } });
  }
  if (blocked.length) parts.push({ key: 'blocked', icon: 'alert', tone: 'warn', text: `${blocked.length} blocked`, short: `${blocked.length} blocked`, title: blocked.length === 1 ? blocked[0]!.title : `${blocked.length} blocked items`, open: { kind: 'work', id: blocked[0]!.id } });
  if (open.length) {
    const count = `${open.length} open ${open.length === 1 ? 'task' : 'tasks'}`;
    parts.push({ key: 'open', icon: 'tasks', text: count, short: count, title: open[0]!.title,
      open: { kind: 'work', id: open[0]!.id } });
  }
  if (result) parts.push({ key: 'result', icon: 'result', text: `${result.finding === 'negative' ? 'Negative result' : 'Result'}: ${result.title}`, short: result.finding === 'negative' ? 'Negative result' : 'New result', title: result.title, open: { kind: 'result', id: result.id } });
  if (proposal) parts.push({ key: 'proposal', icon: null, dot: 'need', tone: canDecide ? 'need' : undefined, text: canDecide ? 'Needs you: a proposed decision' : 'A decision is proposed', short: canDecide ? 'Decision needs you' : 'Decision proposed', title: proposal.title, open: { kind: 'decision', id: proposal.id } });
  // A project with saved history is not an empty project. Keep it quiet when a
  // current rule/action/result already provides orientation, but retain a real
  // reachable object when completed, parked or not-pursued work is all it has.
  if (!parts.length && lists.work.length) {
    const parked = lists.work.filter((item) => item.parked).length;
    const done = lists.work.filter((item) => !item.parked && item.status === 'done').length;
    const notPursued = lists.work.filter((item) => !item.parked && item.status === 'not_pursued').length;
    const text = [done ? `${done} completed ${done === 1 ? 'task' : 'tasks'}` : null,
      notPursued ? `${notPursued} not pursued` : null, parked ? `${parked} parked` : null].filter(Boolean).join(' · ');
    parts.push({ key: 'history', icon: 'tasks', text, short: text, title: lists.work[0]!.title,
      open: { kind: 'work', id: lists.work[0]!.id } });
  }
  if (!parts.length && lists.decisions.length) {
    const text = `${lists.decisions.length} earlier ${lists.decisions.length === 1 ? 'decision' : 'decisions'}`;
    parts.push({ key: 'history', icon: 'rule', text, short: text, title: lists.decisions[0]!.title,
      open: { kind: 'decision', id: lists.decisions[0]!.id } });
  }
  return parts;
}

/**
 * The project's current state in one line. Each part opens its object in Details. The line
 * reads like a sentence: what needs you, the rule, the work and what came out of it.
 */
export function ProjectStateLine({ summary, phase }: { summary: ProjectWorkSummary | null; phase: string }) {
  const { openDetails } = useShellActions();
  // What needs the reader leads, so a narrow header never truncates it away (#117 review).
  if (!summary) return <p className="ws-state ws-state--empty" aria-label="Current state">{phase === 'unavailable' ? 'Current work unavailable' : 'Loading current work…'}</p>;
  const parts = summaryStateParts(summary, summary.access !== 'viewer').sort((a, b) => Number(b.tone === 'need') - Number(a.tone === 'need'));
  if (!parts.length) return <p className="ws-state ws-state--empty" aria-label="Current state" aria-busy={phase === 'refreshing'}>{summaryEmptyCaption(summary)}. Anything said here can become work.</p>;
  return <p className="ws-state" aria-label="Current state" aria-busy={phase === 'refreshing'}>{parts.map((part, index) => <span key={part.key} className="ws-part">{index ? <span className="ws-sep" aria-hidden="true">·</span> : null}<button type="button" className={`ws-seg${part.tone ? ` ws-seg--${part.tone}` : ''}`} data-seg={part.key} title={part.title} onClick={() => openDetails(part.open)}>{part.icon ? <Icon name={part.icon} size={13} /> : <span className={`ws-dot ws-dot--${part.dot}`} aria-hidden="true" />}<span>{part.text}</span></button></span>)}</p>;
}

/**
 * On the phone the state line is one 44 px row that opens the project's overview in Details,
 * where every part opens its object (#117).
 */
export function ProjectStateRow({ summary, phase }: { summary: ProjectWorkSummary | null; phase: string }) {
  const { openDetails } = useShellActions();
  // What needs the reader leads, since the row truncates.
  const parts = summary ? summaryStateParts(summary, summary.access !== 'viewer').sort((a, b) => Number(b.tone === 'need') - Number(a.tone === 'need')) : [];
  const need = parts.find((part) => part.tone === 'need');
  // Keep blocking work readable even when the rest of the phone summary is clipped.
  const blocked = parts.length > 1 ? parts.find((part) => part.key === 'blocked') : undefined;
  const compactParts = blocked ? parts.filter((part) => part !== blocked) : parts;
  return (
    <button type="button" className="ws-state-row" onClick={() => openDetails('place')} aria-haspopup="dialog" aria-busy={phase === 'refreshing'}>
      {need ? <span className="ws-dot ws-dot--need" aria-hidden="true" /> : <Icon name={parts[0]?.icon ?? 'tasks'} size={13} />}
      <span className="ws-state-row__t">{!summary ? phase === 'unavailable' ? 'Current work unavailable' : 'Loading current work…' : compactParts.length ? compactParts.map((part) => part.short).join(' · ') : summaryEmptyCaption(summary)}</span>
      {blocked ? <span className="ws-state-row__blocked">{blocked.short}</span> : null}
      <span className="ui-vh">, open project details</span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

/** A calm chip under a message for an object made from it: icon, title and a quiet state. */
function ObjectChip({ icon, kind, title, need, onOpen, label, objectKind, objectId }: { icon: 'tasks' | 'rule' | 'result'; kind: string; title: string; need?: boolean; onOpen: () => void; label: string; objectKind: string; objectId: string }) {
  return (
    <button type="button" data-work-kind={objectKind} data-work-id={objectId} className={`ws-chip${need ? ' ws-chip--need' : ''}`} onClick={onOpen} aria-label={`${label}: ${title}`}>
      <Icon name={icon} size={14} />
      <span className="ws-chip__t">{title}</span>
      <span className="ws-chip__k">{kind}</span>
    </button>
  );
}

/** The icon already says "work": "Work · In progress · Kai" → "In progress · Kai". */
const rest = (line: string) => line.replace(/^Work · /, '');

/** Objects made from this message. The message itself is unchanged; these link back to it. */
export function MessageObjects({ message, projectId, preview }: { message: ConversationMessage; projectId: string; preview: MessageWorkPreview | null }) {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  if (!preview) return null;
  const { counts, items } = preview;
  const total = counts.work + counts.decisions + counts.results;
  if (!total) return null;
  return (
    <div className="ws-attach">
      {items.map((item) => <ObjectChip key={`${item.kind}:${item.id}`} objectKind={item.kind} objectId={item.id} icon={item.kind === 'work' ? 'tasks' : item.kind === 'decision' ? 'rule' : 'result'} kind={item.kind === 'work' ? rest(workLine(item)) : item.kind === 'decision' ? decisionLine(item) : resultLine(item)} title={item.title} need={item.kind === 'decision' && item.status === 'proposed'} label={item.kind === 'work' ? 'Work' : item.kind === 'decision' ? 'Decision' : 'Result'} onOpen={() => openDetails({ kind: item.kind, id: item.id })} />)}
      {items.length < total ? <button type="button" className="ws-attach__more" onClick={() => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } })}>{[counts.work ? `${counts.work} work` : null, counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? 'decision' : 'decisions'}` : null, counts.results ? `${counts.results} ${counts.results === 1 ? 'result' : 'results'}` : null].filter(Boolean).join(' · ')} · view linked objects</button> : null}
    </div>
  );
}

/**
 * Creates work from a message in one action. A failed attempt keeps its Idempotency-Key, so
 * retrying after a lost response returns the same work item instead of a duplicate.
 */
export function useCreateWorkFromMessage(project: Project) {
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const keys = useRef(new Map<string, string>());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ messageId: string; text: string } | null>(null);
  const create = useCallback(async (message: ConversationMessage) => {
    const key = keys.current.get(message.id) ?? crypto.randomUUID();
    keys.current.set(message.id, key);
    setBusy(message.id); setFailed(null);
    try {
      const item = await createWork(project.id, { title: firstLine(message.body), sources: [{ type: 'message', id: message.id }] }, key);
      keys.current.delete(message.id);
      revalidator.revalidate();
      openDetails({ kind: 'work', id: item.id });
    } catch (cause) {
      setFailed({ messageId: message.id, text: cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not add work.' : cause instanceof Error ? cause.message : 'Could not create the work.' });
    } finally { setBusy(null); }
  }, [openDetails, project.id, revalidator]);
  return { create, busy, failed };
}

/**
 * Quiet actions under a message, named by what they make (Task, Decision, Result) and Details (#189):
 * shown on hover and focus with a pointer and keyboard; on touch
 * one "Make from this message" button opens them, so a phone feed is not a wall of buttons.
 * On a pointer they float over the message's corner and take no room in the feed. "Details" shows everything linked to this message (#117); readers without write access
 * get only that.
 */
export function MessageActions({ projectId, message, onCreateWork, busy, writable = true }: { projectId: string; message: ConversationMessage; onCreateWork: () => void; busy: boolean; writable?: boolean }) {
  const { openDetails } = useShellActions();
  const touch = useMediaQuery('(hover: none)');
  const [open, setOpen] = useState(false);
  const source = { messageId: message.id, text: message.body };
  const { me } = useShellData();
  const details = <button type="button" className="ws-act" onClick={() => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } })} aria-label="Details of this message"><Icon name="panel" size={14} />Details</button>;
  if (!writable) return <div className="ws-acts">{details}</div>;
  if (touch && !open) {
    // One quiet 44 px overflow button in the message's corner instead of a row under every message.
    return <div className="ws-acts ws-acts--more"><button type="button" className="ws-act ws-more" aria-expanded="false" aria-label="Make from this message" onClick={() => setOpen(true)}><Icon name="more" size={16} /></button></div>;
  }
  return (
    <div className="ws-acts" role="group" aria-label="Make something from this message">
      <button type="button" className="ws-act" onClick={onCreateWork} aria-busy={busy || undefined} disabled={busy}><Icon name="tasks" size={14} />{busy ? 'Creating…' : 'Task'}</button>
      <button type="button" className="ws-act" onClick={() => openDetails({ kind: 'propose-decision', projectId, source })}><Icon name="rule" size={14} />Decision</button>
      <button type="button" className="ws-act" onClick={() => openDetails({ kind: 'attach-result', projectId, source })}><Icon name="result" size={14} />Result</button>
      {details}
    </div>
  );
}
