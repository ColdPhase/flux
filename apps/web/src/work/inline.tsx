import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import type { ConversationMessage, Decision, Project, WorkItem, WorkResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Icon } from '../ui';
import { useShellActions } from '../app/shellContext';
import { createWork, type ProjectWork } from './api';
import { decisionLine, firstLine, fromMessage, resultLine, workLine } from './format';
import './work.css';

// Work objects inside the conversation (#101, C direction): the calm state line under the
// header, the quiet actions of a message and the framed objects that were made from it.

/**
 * The project's current state in one line: the rule in force, work in progress and a proposal
 * waiting for a person. Each part opens its object in Details.
 */
export function ProjectStateLine({ lists, canDecide }: { lists: ProjectWork; canDecide: boolean }) {
  const { openDetails } = useShellActions();
  const rule = lists.decisions.find((decision) => decision.status === 'accepted');
  const proposal = lists.decisions.find((decision) => decision.status === 'proposed');
  const active = lists.work.filter((item) => item.status === 'in_progress' && !item.parked);
  const blocked = lists.work.filter((item) => item.status === 'blocked' && !item.parked);
  const parts: { key: string; node: ReactNode }[] = [];
  if (rule) parts.push({ key: 'rule', node: <button type="button" className="ws-seg" onClick={() => openDetails({ kind: 'decision', id: rule.id })}><Icon name="rule" size={13} /><span>Current rule: {rule.title}</span></button> });
  if (active.length) {
    const names = [...new Set(active.map((item) => item.owner?.name).filter(Boolean))];
    parts.push({ key: 'work', node: <button type="button" className="ws-seg" onClick={() => openDetails({ kind: 'work', id: active[0]!.id })}><span className="ws-dot ws-dot--progress" aria-hidden="true" /><span>{active.length === 1 ? `In progress: ${active[0]!.title}` : `${active.length} in progress`}{names.length ? ` (${names.join(', ')})` : ''}</span></button> });
  }
  if (blocked.length) parts.push({ key: 'blocked', node: <button type="button" className="ws-seg ws-seg--warn" onClick={() => openDetails({ kind: 'work', id: blocked[0]!.id })}><Icon name="alert" size={13} /><span>{blocked.length} blocked</span></button> });
  if (proposal) parts.push({ key: 'proposal', node: <button type="button" className={`ws-seg${canDecide ? ' ws-seg--need' : ''}`} onClick={() => openDetails({ kind: 'decision', id: proposal.id })}><span className="ws-dot ws-dot--need" aria-hidden="true" /><span>{canDecide ? 'A proposed decision is waiting for you' : 'A decision is proposed'}</span></button> });
  if (!parts.length) return <p className="ws-state ws-state--empty" aria-label="Current state">No decisions or work yet. Anything said here can become one.</p>;
  return <p className="ws-state" aria-label="Current state">{parts.map((part, index) => <span key={part.key} className="ws-part">{index ? <span className="ws-sep" aria-hidden="true">·</span> : null}{part.node}</span>)}</p>;
}

function ObjectCard({ icon, kind, title, need, onOpen, label }: { icon: 'tasks' | 'rule' | 'result'; kind: string; title: string; need?: boolean; onOpen: () => void; label: string }) {
  return (
    <button type="button" className="ws-obj" onClick={onOpen} aria-label={`${label}: ${title}`}>
      <span className="ws-obj__ic" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <span className="ws-obj__b"><span className={`ws-obj__k${need ? ' ws-need' : ''}`}>{kind}</span><span className="ws-obj__t">{title}</span></span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

/** Objects made from this message. The message itself is unchanged; these link back to it. */
export function MessageObjects({ messageId, lists }: { messageId: string; lists: ProjectWork }) {
  const { openDetails } = useShellActions();
  const work: WorkItem[] = fromMessage(lists.work, messageId);
  const decisions: Decision[] = fromMessage(lists.decisions, messageId);
  const results: WorkResult[] = fromMessage(lists.results, messageId);
  if (!work.length && !decisions.length && !results.length) return null;
  return (
    <div className="ws-attach">
      {work.map((item) => <ObjectCard key={item.id} icon="tasks" kind={workLine(item)} title={item.title} label="Work" onOpen={() => openDetails({ kind: 'work', id: item.id })} />)}
      {decisions.map((item) => <ObjectCard key={item.id} icon="rule" kind={decisionLine(item)} title={item.title} need={item.status === 'proposed'} label="Decision" onOpen={() => openDetails({ kind: 'decision', id: item.id })} />)}
      {results.map((item) => <ObjectCard key={item.id} icon="result" kind={resultLine(item)} title={item.title} label="Result" onOpen={() => openDetails({ kind: 'result', id: item.id })} />)}
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

/** Quiet actions under a message: always reachable by keyboard, always visible on touch. */
export function MessageActions({ projectId, message, onCreateWork, busy }: { projectId: string; message: ConversationMessage; onCreateWork: () => void; busy: boolean }) {
  const { openDetails } = useShellActions();
  const source = { messageId: message.id, text: message.body };
  return (
    <div className="ws-acts" role="group" aria-label="Make something from this message">
      <button type="button" className="ws-act" onClick={onCreateWork} aria-busy={busy || undefined} disabled={busy}><Icon name="tasks" size={14} />{busy ? 'Creating…' : 'Create work'}</button>
      <button type="button" className="ws-act" onClick={() => openDetails({ kind: 'propose-decision', projectId, source })}><Icon name="rule" size={14} />Propose decision</button>
      <button type="button" className="ws-act" onClick={() => openDetails({ kind: 'attach-result', projectId, source })}><Icon name="result" size={14} />Attach result</button>
    </div>
  );
}
