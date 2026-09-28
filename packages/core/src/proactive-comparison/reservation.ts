/** A possible charge, never permission to reuse an old access decision. */
export type ReservationResult =
  | { status: 'reserved'; id: string; ownerUserId: string; ruleId: string; resultId: string; connectionId: string; reservedCents: number }
  | { status: 'blocked'; reason: 'NOT_QUEUED' | 'RULE_STOPPED' | 'OWNER_OR_AGENT_ACCESS' | 'SOURCE_CHANGED' |
      'SOURCE_SCOPE_UNVERIFIED' | 'CONNECTION_REQUIRED' | 'BUDGET_EXHAUSTED' | 'OWNER_IN_FLIGHT' };

type Candidate = { id: string; status: string; ruleId: string; ownerUserId: string; projectId: string; resultId: string; sourceFingerprint: string };
type Rule = { id: string; status: string; ownerUserId: string; projectId: string; agentId: string;
  maxRunsPerDay: number; periodBudgetCents: number; perRunCents: number };
type Result = { projectId: string; finding: string; createdByKind: string; createdById: string };
type Connection = { id: string; encryptedKey: string | null; periodDays: number; consentVersion: string;
  maxRunsPerDay: number; periodBudgetCents: number; perRunCents: number };
type Source = { type: string; id: string; version: number | null };

export interface ReservationPorts {
  rows: {
    lockCandidate(id: string): Promise<Candidate | null>;
    lockOwner(ownerId: string): Promise<boolean>;
    rule(id: string): Promise<Rule | null>;
    result(id: string): Promise<Result | null>;
    sourceSnapshot(resultId: string): Promise<{ fingerprint: string; sources: Source[] }>;
    sourceCurrent(projectId: string, source: Source): Promise<boolean>;
    connection(ownerId: string): Promise<Connection | null>;
    usage(ownerId: string, startOfDay: Date, startOfPeriod: Date): Promise<{ dayRuns: number; periodCents: number; inFlight: number }>;
    reserve(id: string, connectionId: string, cents: number, at: Date): Promise<unknown | null>;
    cancel(id: string): Promise<void>;
  };
  access: { currentOwnerAndAgent(ownerId: string, agentId: string, projectId: string): Promise<boolean> };
}
export interface ReservationUnitOfWork {
  run<T>(action: (ports: ReservationPorts) => Promise<T>): Promise<T>;
}

const blocked = (reason: Extract<ReservationResult, { status: 'blocked' }>['reason']): ReservationResult => ({ status: 'blocked', reason });
const RESERVE_CENTS = 5; // O-007 dated estimate floor for one bounded Messages request.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Internal pre-dispatch gate. No key is decrypted and no provider is called here.
 * A worker must recheck current access and sources before calling and before commit;
 * this reservation is not a bearer grant.
 */
export function reservationUseCases(unit: ReservationUnitOfWork) {
  return {
    reserve(candidateId: string, now = new Date()): Promise<ReservationResult> {
      return unit.run(async ({ rows, access }) => {
        const candidate = await rows.lockCandidate(candidateId);
        if (!candidate || candidate.status !== 'queued') return blocked('NOT_QUEUED');
        // All reservations and key replacement/revocation serialize on the owner row.
        if (!await rows.lockOwner(candidate.ownerUserId)) return blocked('OWNER_OR_AGENT_ACCESS');
        const rule = await rows.rule(candidate.ruleId);
        const result = await rows.result(candidate.resultId);
        if (!rule || rule.status !== 'enabled' || rule.ownerUserId !== candidate.ownerUserId
          || rule.projectId !== candidate.projectId || !result || result.projectId !== candidate.projectId
          || result.finding !== 'negative' || result.createdByKind !== 'human'
          || result.createdById !== candidate.ownerUserId) {
          await rows.cancel(candidate.id);
          return blocked('RULE_STOPPED');
        }
        if (!await access.currentOwnerAndAgent(candidate.ownerUserId, rule.agentId, candidate.projectId)) {
          await rows.cancel(candidate.id);
          return blocked('OWNER_OR_AGENT_ACCESS');
        }
        const snapshot = await rows.sourceSnapshot(candidate.resultId);
        if (snapshot.fingerprint !== candidate.sourceFingerprint) {
          await rows.cancel(candidate.id);
          return blocked('SOURCE_CHANGED');
        }
        for (const source of snapshot.sources) {
          // Only immutable messages/results and pinned current material revisions are
          // supported by this first preflight. A mutable source needs a versioned reader.
          if (source.type !== 'message' && source.type !== 'result' && source.type !== 'material')
            return blocked('SOURCE_SCOPE_UNVERIFIED');
          if (source.type === 'material' && (!source.version || source.version < 1))
            return blocked('SOURCE_SCOPE_UNVERIFIED');
          if (!await rows.sourceCurrent(candidate.projectId, source)) {
            await rows.cancel(candidate.id);
            return blocked('SOURCE_CHANGED');
          }
        }
        const connection = await rows.connection(candidate.ownerUserId);
        if (!connection || !connection.encryptedKey) return blocked('CONNECTION_REQUIRED');
        if (connection.periodDays !== 30 || connection.consentVersion !== 'o-007-2026-09-28'
          || Math.min(rule.perRunCents, connection.perRunCents) < RESERVE_CENTS)
          return blocked('BUDGET_EXHAUSTED');
        const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const periodStart = new Date(now.getTime() - 30 * DAY_MS);
        const usage = await rows.usage(candidate.ownerUserId, utcDay, periodStart);
        if (usage.inFlight) return blocked('OWNER_IN_FLIGHT');
        if (usage.dayRuns >= Math.min(rule.maxRunsPerDay, connection.maxRunsPerDay)
          || usage.periodCents + RESERVE_CENTS > Math.min(rule.periodBudgetCents, connection.periodBudgetCents))
          return blocked('BUDGET_EXHAUSTED');
        if (!await rows.reserve(candidate.id, connection.id, RESERVE_CENTS, now)) return blocked('NOT_QUEUED');
        return { status: 'reserved', id: candidate.id, ownerUserId: candidate.ownerUserId,
          ruleId: candidate.ruleId, resultId: candidate.resultId, connectionId: connection.id,
          reservedCents: RESERVE_CENTS };
      });
    },
  };
}
