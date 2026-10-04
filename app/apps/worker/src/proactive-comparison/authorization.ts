import { proactiveOutboxRows } from '@flux/db';
import { evaluateProject, type Database, type Executor } from '@flux/core';

export type ObservedUsage = { inputTokens: number; outputTokens: number; estimatedCents: number };

export class ComparisonStopped extends Error {
  constructor(readonly code: string, readonly usage?: ObservedUsage) { super(code); }
}

/** Short transaction guards are used when collecting input and when publishing, never during HTTP. */
export async function authorizedComparison(db: Executor, candidateId: string, connectionId: string,
  expectedRuleVersion?: number, lock = false) {
  const rows = proactiveOutboxRows(db);
  const candidate = await rows.candidate(candidateId);
  if (!candidate || candidate.status !== 'reserved' || candidate.connectionId !== connectionId)
    throw new ComparisonStopped('RESERVATION_CHANGED');
  if (lock) await rows.lockOwner(candidate.ownerUserId);
  const rule = await rows.rule(candidate.ruleId);
  const connection = await rows.connectionState(candidate.ownerUserId);
  if (!rule || rule.status !== 'enabled' || rule.ownerUserId !== candidate.ownerUserId
    || rule.projectId !== candidate.projectId
    || !connection || connection.id !== candidate.connectionId || !connection.keyAvailable
    || (expectedRuleVersion !== undefined && rule.version !== expectedRuleVersion))
    throw new ComparisonStopped('AUTHORIZATION_CHANGED');
  const owner = await evaluateProject({ kind: 'human', id: candidate.ownerUserId }, 'project.write', candidate.projectId, db, { lock });
  const agent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', candidate.projectId, db, { lock });
  if (!owner.allowed || !agent.allowed || agent.actor?.agent?.ownerUserId !== candidate.ownerUserId)
    throw new ComparisonStopped('ACCESS_CHANGED');
  const result = await rows.resultState(candidate.resultId);
  if (!result || result.projectId !== candidate.projectId || result.finding !== 'negative' || result.createdByKind !== 'human')
    throw new ComparisonStopped('AUTHORIZATION_CHANGED');
  const snapshot = await rows.sourceSnapshot(candidate.resultId, candidate.ruleId);
  if (snapshot.ruleVersion !== rule.version) throw new ComparisonStopped('AUTHORIZATION_CHANGED');
  if (snapshot.fingerprint !== candidate.sourceFingerprint) throw new ComparisonStopped('SOURCE_CHANGED');
  for (const source of snapshot.sources) {
    if (!await rows.sourceCurrent(candidate.projectId, source)) throw new ComparisonStopped('SOURCE_CHANGED');
  }
  const taskFence = lock ? await rows.prepareTaskUse(candidate.projectId, [{ type: 'result', id: candidate.resultId }, ...snapshot.sources]) : null;
  if (lock) {
    const retained = await rows.lockCandidate(candidateId);
    if (!retained || retained.status !== candidate.status || retained.connectionId !== connectionId
      || retained.sourceFingerprint !== candidate.sourceFingerprint) throw new ComparisonStopped('RESERVATION_CHANGED');
  }
  return { rows, candidate, rule, result, connection, snapshot, taskFence };
}

/**
 * Cancellation reads metadata only. Each check releases its SQL locks before the next HTTP
 * step, so a pause/revocation can commit while a provider response is pending. A final locked
 * check still prevents a late response from being published after authorization changes.
 */
export function watchComparisonAuthorization(db: Database, candidateId: string, connectionId: string, ruleVersion: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<void> | null = null;
  let stopped = false;
  const check = async () => {
    if (controller.signal.aborted || stopped) return;
    try { await authorizedComparison(db, candidateId, connectionId, ruleVersion); }
    catch (error) {
      controller.abort(error instanceof ComparisonStopped ? error : new ComparisonStopped('AUTHORIZATION_CHECK_FAILED'));
    }
  };
  const tick = () => {
    checking = check().finally(() => {
      checking = null;
      if (!stopped && !controller.signal.aborted) { timer = setTimeout(tick, 250); timer.unref(); }
    });
  };
  tick();
  return {
    signal: controller.signal,
    async check() { await checking; await check(); controller.signal.throwIfAborted(); },
    async stop() { stopped = true; clearTimeout(timer); await checking; },
  };
}

/** Return promptly even if a provider ignores AbortSignal; its late answer cannot publish. */
export function abortableComparisonCall<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return call(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
