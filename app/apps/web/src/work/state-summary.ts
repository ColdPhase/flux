import type { ProjectWorkSummary, WorkObjectType } from '@flux/contracts';

export interface StatePart {
  key: 'rule' | 'work' | 'blocked' | 'open' | 'history' | 'result' | 'proposal';
  icon: 'rule' | 'result' | 'alert' | 'tasks' | null;
  dot?: 'progress' | 'need';
  text: string;
  short: string;
  title: string;
  tone?: 'warn' | 'need';
  open: { kind: WorkObjectType; id: string };
}

export function summaryStateParts(summary: ProjectWorkSummary, canDecide: boolean): StatePart[] {
  const { rule, proposal, active, blocked, open, history, result } = summary.state;
  const parts: StatePart[] = [];
  if (rule) parts.push({ key: 'rule', icon: 'rule', text: `Current rule: ${rule.title}`, short: `Rule: ${rule.title}`, title: rule.title, open: { kind: 'decision', id: rule.id } });
  if (active.count && active.first) {
    // Server distinctness is native kind/id. Identical names remain separate owners.
    const names = active.owners.map((owner) => owner.name);
    const remaining = Math.max(0, active.ownerTotal - names.length);
    const labels = [...names, ...(remaining ? [`${remaining} ${remaining === 1 ? 'other' : 'others'}`] : [])];
    const who = labels.length ? ` (${labels.join(', ')})` : '';
    parts.push({ key: 'work', icon: null, dot: 'progress', text: `${active.count === 1 ? `In progress: ${active.first.title}` : `${active.count} in progress`}${who}`, short: `Work in progress${who}`, title: active.count === 1 ? `${active.first.title}${who}` : `${active.count} items in progress${who}`, open: { kind: 'work', id: active.first.id } });
  }
  if (blocked.count && blocked.first) parts.push({ key: 'blocked', icon: 'alert', tone: 'warn', text: `${blocked.count} blocked`, short: `${blocked.count} blocked`, title: blocked.count === 1 ? blocked.first.title : `${blocked.count} blocked items`, open: { kind: 'work', id: blocked.first.id } });
  if (open.count && open.first) {
    const text = `${open.count} open ${open.count === 1 ? 'task' : 'tasks'}`;
    parts.push({ key: 'open', icon: 'tasks', text, short: text, title: open.first.title, open: { kind: 'work', id: open.first.id } });
  }
  if (result) parts.push({ key: 'result', icon: 'result', text: `${result.finding === 'negative' ? 'Negative result' : 'Result'}: ${result.title}`, short: result.finding === 'negative' ? 'Negative result' : 'New result', title: result.title, open: { kind: 'result', id: result.id } });
  if (proposal) parts.push({ key: 'proposal', icon: null, dot: 'need', tone: canDecide ? 'need' : undefined, text: canDecide ? 'Needs you: a proposed decision' : 'A decision is proposed', short: canDecide ? 'Decision needs you' : 'Decision proposed', title: proposal.title, open: { kind: 'decision', id: proposal.id } });
  if (!parts.length && history.firstWork) {
    const text = [history.completed ? `${history.completed} completed ${history.completed === 1 ? 'task' : 'tasks'}` : null,
      history.notPursued ? `${history.notPursued} not pursued` : null, history.parked ? `${history.parked} parked` : null].filter(Boolean).join(' · ');
    parts.push({ key: 'history', icon: 'tasks', text, short: text, title: history.firstWork.title,
      open: { kind: 'work', id: history.firstWork.id } });
  }
  if (!parts.length && history.firstDecision) {
    const text = `${history.decisionCount} earlier ${history.decisionCount === 1 ? 'decision' : 'decisions'}`;
    parts.push({ key: 'history', icon: 'rule', text, short: text, title: history.firstDecision.title,
      open: { kind: 'decision', id: history.firstDecision.id } });
  }
  return parts;
}

export function summaryEmptyCaption(summary: ProjectWorkSummary) {
  const objects = Object.values(summary.all).reduce((total, count) => total + count, 0);
  if (!objects && !summary.state.history.decisionCount) return 'No decisions or work yet';
  if (summary.workTotal) return `${summary.workTotal} ${summary.workTotal === 1 ? 'work item' : 'work items'}`;
  if (!objects) return `${summary.state.history.decisionCount} earlier ${summary.state.history.decisionCount === 1 ? 'decision' : 'decisions'}`;
  return `${objects} ${objects === 1 ? 'project object' : 'project objects'}`;
}
