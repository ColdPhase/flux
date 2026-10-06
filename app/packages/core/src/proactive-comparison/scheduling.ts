import { GITHUB_RULE_AUTOMATION } from '../github/rules.js';

/** Accepted #58 source-change window; shared by event collection and readiness. */
export const COMPARISON_QUIET_WINDOW_MS = 2 * 60_000;
export const COMPARISON_MAX_WAIT_MS = 15 * 60_000;
export const COMPARISON_EVENT_BATCH = 100;
export const COMPARISON_RESULT_BATCH = 100;

export interface ComparisonSourceEvent {
  seq: number; kind: string; actorId: string; objectId: string; data: Record<string, unknown>;
}
export interface ComparisonChangeWindow {
  projectId: string; firstChangedAt: Date; lastChangedAt: Date; dueAt: Date;
}
export interface ComparisonSchedulingRule { id: string; ownerUserId: string; agentId: string; projectId: string }
export interface ComparisonSchedulingPorts {
  events: {
    /** The cursor lock lasts for this unit of work, serializing event consumers. */
    lockCursor(): Promise<number>;
    retainedRange(): Promise<{ first: number | null; last: number | null }>;
    after(seq: number, limit: number): Promise<ComparisonSourceEvent[]>;
    /** May reset a cursor after a rebuilt log, while still holding its lock. */
    storeCursor(seq: number): Promise<void>;
  };
  projects: {
    /** Metadata only: validate current project scope, published version and provenance. */
    forHumanSourceEvent(event: ComparisonSourceEvent): Promise<string | null>;
    enabledAfter(projectId: string | null, limit: number): Promise<string[]>;
  };
  changes: {
    lockProject(projectId: string): Promise<ComparisonChangeWindow | null>;
    save(window: ComparisonChangeWindow): Promise<void>;
    dueProjectIds(now: Date, limit: number): Promise<string[]>;
    remove(projectId: string): Promise<void>;
  };
  rules: { enabledForProject(projectId: string): Promise<ComparisonSchedulingRule[]> };
  access: { currentOwnerAndAgent(rule: ComparisonSchedulingRule): Promise<boolean> };
  sources: {
    negativeResultsAfter(projectId: string, resultId: string | null, limit: number): Promise<string[]>;
    /** Call only after current owner/agent project authorization. */
    snapshot(resultId: string, ruleId: string): Promise<{ fingerprint: string }>;
  };
  candidates: {
    stopObsoleteQueued(ruleId: string, resultId: string, fingerprint: string): Promise<number>;
    /** Unique rule/result/fingerprint; never replaces a dismissal or paid candidate. */
    insert(input: { rule: ComparisonSchedulingRule; resultId: string; fingerprint: string; availableAfter: Date }): Promise<boolean>;
  };
}
export interface ComparisonSchedulingUnitOfWork {
  run<T>(action: (ports: ComparisonSchedulingPorts) => Promise<T>): Promise<T>;
}

const sourceKinds = new Set([
  'project.material_created.v1', 'project.material_updated.v1', 'project.doc_created.v1', 'project.doc_updated.v1',
  'project.conversation_created.v1', 'project.message_sent.v1', 'project.work_created.v1', 'project.work_updated.v1',
  'project.result_recorded.v1', 'project.link_created.v1',
]);
const thoughtContent = new Set(['thought_added', 'thought_updated', 'thought_removed']);
function humanSourceEvent(event: ComparisonSourceEvent) {
  // A task rule's automatic change (#74 G-1a) is recorded under its author but is not their activity.
  if (event.data.automation === GITHUB_RULE_AUTOMATION) return false;
  return event.actorId.startsWith('human:') && (sourceKinds.has(event.kind)
    || (event.kind === 'sketch.changed.v1' && typeof event.data.op === 'string' && thoughtContent.has(event.data.op)));
}

export function comparisonChangeWindow(projectId: string, previous: ComparisonChangeWindow | null, now: Date): ComparisonChangeWindow {
  const firstChangedAt = previous?.firstChangedAt ?? now;
  const lastChangedAt = new Date(Math.max(previous?.lastChangedAt.getTime() ?? now.getTime(), now.getTime()));
  return { projectId, firstChangedAt, lastChangedAt,
    dueAt: new Date(Math.min(lastChangedAt.getTime() + COMPARISON_QUIET_WINDOW_MS, firstChangedAt.getTime() + COMPARISON_MAX_WAIT_MS)) };
}

/** Cursor and reconsideration rows commit together; no source bodies or provider calls. */
export function collectComparisonSourceChanges(unit: ComparisonSchedulingUnitOfWork, now = new Date()) {
  return unit.run(async (ports) => {
    const cursor = await ports.events.lockCursor();
    const range = await ports.events.retainedRange();
    const recovered = (range.first !== null && cursor < range.first - 1)
      || cursor > (range.last ?? 0);
    const mark = async (projectId: string) => ports.changes.save(comparisonChangeWindow(projectId, await ports.changes.lockProject(projectId), now));
    if (recovered) {
      let after: string | null = null; let projects = 0;
      for (;;) {
        const page = await ports.projects.enabledAfter(after, COMPARISON_RESULT_BATCH);
        for (const projectId of page) { await mark(projectId); projects++; }
        if (page.length < COMPARISON_RESULT_BATCH) break;
        const last = page.at(-1)!;
        if (last === after) throw new Error('Enabled-project paging did not advance');
        after = last;
      }
      await ports.events.storeCursor(range.last ?? 0);
      return { processed: 0, marked: projects, cursor: range.last ?? 0, recovered: true };
    }
    const events = await ports.events.after(cursor, COMPARISON_EVENT_BATCH);
    let last = cursor; let marked = 0;
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= last) throw new Error('Committed-event paging did not advance');
      last = event.seq;
      if (!humanSourceEvent(event)) continue;
      const projectId = await ports.projects.forHumanSourceEvent(event);
      if (projectId) { await mark(projectId); marked++; }
    }
    if (last !== cursor) await ports.events.storeCursor(last);
    return { processed: events.length, marked, cursor: last, recovered: false };
  });
}

/** One due project per short transaction. Replica races serialize on its due row. */
export async function reconsiderComparisonSources(unit: ComparisonSchedulingUnitOfWork, now = new Date(), limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('A reconsideration limit of 1–100 is required');
  const ids = await unit.run((ports) => ports.changes.dueProjectIds(now, limit));
  let processed = 0; let created = 0; let obsolete = 0;
  for (const projectId of ids) {
    const result = await unit.run(async (ports) => {
      const window = await ports.changes.lockProject(projectId);
      if (!window || window.dueAt > now) return null;
      let inserted = 0; let stopped = 0;
      for (const rule of await ports.rules.enabledForProject(projectId)) {
        if (rule.projectId !== projectId || !await ports.access.currentOwnerAndAgent(rule)) continue;
        let after: string | null = null;
        for (;;) {
          const page = await ports.sources.negativeResultsAfter(projectId, after, COMPARISON_RESULT_BATCH);
          for (const resultId of page) {
            const { fingerprint } = await ports.sources.snapshot(resultId, rule.id);
            if (!/^[0-9a-f]{64}$/.test(fingerprint)) continue;
            stopped += await ports.candidates.stopObsoleteQueued(rule.id, resultId, fingerprint);
            if (await ports.candidates.insert({ rule, resultId, fingerprint, availableAfter: now })) inserted++;
          }
          if (page.length < COMPARISON_RESULT_BATCH) break;
          const last = page.at(-1)!;
          if (last === after) throw new Error('Negative-result paging did not advance');
          after = last;
        }
      }
      await ports.changes.remove(projectId);
      return { inserted, stopped };
    });
    if (result) { processed++; created += result.inserted; obsolete += result.stopped; }
  }
  return { processed, created, obsolete };
}
