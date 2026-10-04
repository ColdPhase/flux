import { BACKGROUND_COMPARISON_LIMITS, BACKGROUND_CONSENT_VERSIONS, maxRequestMicros, type AiPrice } from '@flux/contracts';

/** A possible charge, never permission to reuse an old access decision. */
export type ReservationResult =
  | { status: 'reserved'; id: string; ownerUserId: string; ruleId: string; resultId: string; connectionId: string; reservedCents: number }
  | { status: 'blocked'; reason: 'NOT_QUEUED' | 'RULE_STOPPED' | 'OWNER_OR_AGENT_ACCESS' | 'SOURCE_CHANGED' |
      'SOURCE_SCOPE_UNVERIFIED' | 'CONNECTION_REQUIRED' | 'CONNECTION_PRICE_UNKNOWN' | 'BUDGET_EXHAUSTED' | 'OWNER_IN_FLIGHT' | 'QUIET_WINDOW' };

type Candidate = { id: string; status: string; ruleId: string; ownerUserId: string; projectId: string; resultId: string; sourceFingerprint: string };
type Rule = { id: string; version: number; status: string; ownerUserId: string; projectId: string; agentId: string;
  maxRunsPerDay: number; periodBudgetCents: number; perRunCents: number };
type Result = { projectId: string; finding: string; createdByKind: string; createdById: string };
type Connection = { id: string; encryptedKey: string | null; periodDays: number; consentVersion: string;
  maxRunsPerDay: number; periodBudgetCents: number; perRunCents: number;
  inputPriceMicrosPerMTok: number | null; outputPriceMicrosPerMTok: number | null };
type Source = { type: string; id: string; version: number | null; sketchId?: string };

export interface ReservationPorts {
  rows: {
    lockCandidate(id: string): Promise<Candidate | null>;
    lockOwner(ownerId: string): Promise<boolean>;
    rule(id: string): Promise<Rule | null>;
    result(id: string): Promise<Result | null>;
    sourceSnapshot(resultId: string, ruleId: string): Promise<{ fingerprint: string; sources: Source[]; ruleVersion: number | null }>;
    sourceCurrent(projectId: string, source: Source): Promise<boolean>;
    ready(id: string, now: Date): Promise<boolean>;
    connection(ownerId: string): Promise<Connection | null>;
    usage(ownerId: string, startOfDay: Date, startOfPeriod: Date): Promise<{ dayRuns: number; periodCents: number; inFlight: number }>;
    reserve(id: string, connectionId: string, cents: number, at: Date): Promise<unknown | null>;
    cancel(id: string, reason: string): Promise<void>;
  };
  access: { currentOwnerAndAgent(ownerId: string, agentId: string, projectId: string): Promise<boolean> };
}
export interface ReservationUnitOfWork {
  run<T>(action: (ports: ReservationPorts) => Promise<T>): Promise<T>;
}

const blocked = (reason: Extract<ReservationResult, { status: 'blocked' }>['reason']): ReservationResult => ({ status: 'blocked', reason });
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reservation of one bounded comparison request at the connection's price (PROV-3): its largest
 * possible cost, 8,000 input and 1,200 output tokens, in whole cents, and never below O-007's
 * $0.05 floor for estimate drift, which F-020 keeps for every provider.
 */
export function comparisonReservationCents(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>): number {
  const micros = maxRequestMicros(price, BACKGROUND_COMPARISON_LIMITS.maxInputTokens, BACKGROUND_COMPARISON_LIMITS.maxOutputTokens);
  return Math.max(BACKGROUND_COMPARISON_LIMITS.minimumReserveCents, Math.ceil(micros / 10_000));
}

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
        const refuse = async (reason: Extract<ReservationResult, { status: 'blocked' }>['reason']) => {
          await rows.cancel(candidate.id, reason);
          return blocked(reason);
        };
        // All reservations and key replacement/revocation serialize on the owner row.
        if (!await rows.lockOwner(candidate.ownerUserId)) return refuse('OWNER_OR_AGENT_ACCESS');
        const rule = await rows.rule(candidate.ruleId);
        const result = await rows.result(candidate.resultId);
        if (!rule || rule.status !== 'enabled' || rule.ownerUserId !== candidate.ownerUserId
          || rule.projectId !== candidate.projectId || !result || result.projectId !== candidate.projectId
          || result.finding !== 'negative' || result.createdByKind !== 'human') {
          return refuse('RULE_STOPPED');
        }
        if (!await access.currentOwnerAndAgent(candidate.ownerUserId, rule.agentId, candidate.projectId)) {
          return refuse('OWNER_OR_AGENT_ACCESS');
        }
        const snapshot = await rows.sourceSnapshot(candidate.resultId, candidate.ruleId);
        if (snapshot.ruleVersion !== rule.version) {
          return refuse('RULE_STOPPED');
        }
        if (snapshot.fingerprint !== candidate.sourceFingerprint) {
          return refuse('SOURCE_CHANGED');
        }
        for (const source of snapshot.sources) {
          // Immutable human messages/results and pinned current human material/work/thought
          // revisions are checked again before reading content, dispatch and publication.
          if (source.type !== 'message' && source.type !== 'result' && source.type !== 'material' && source.type !== 'work' && source.type !== 'thought')
            return refuse('SOURCE_SCOPE_UNVERIFIED');
          if ((source.type === 'material' || source.type === 'work' || source.type === 'thought') && (!source.version || source.version < 1))
            return refuse('SOURCE_SCOPE_UNVERIFIED');
          if (!await rows.sourceCurrent(candidate.projectId, source)) {
            return refuse('SOURCE_CHANGED');
          }
        }
        // A queued id is not permission to bypass uncollected events or a quiet window.
        if (!await rows.ready(candidate.id, now)) return blocked('QUIET_WINDOW');
        const connection = await rows.connection(candidate.ownerUserId);
        if (!connection || !connection.encryptedKey) return refuse('CONNECTION_REQUIRED');
        if (connection.inputPriceMicrosPerMTok === null || connection.outputPriceMicrosPerMTok === null) return refuse('CONNECTION_PRICE_UNKNOWN');
        const reserveCents = comparisonReservationCents({ inputMicrosPerMTok: connection.inputPriceMicrosPerMTok,
          outputMicrosPerMTok: connection.outputPriceMicrosPerMTok });
        if (connection.periodDays !== 30 || !(BACKGROUND_CONSENT_VERSIONS as readonly string[]).includes(connection.consentVersion)
          || Math.min(rule.perRunCents, connection.perRunCents) < reserveCents)
          return refuse('BUDGET_EXHAUSTED');
        const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const periodStart = new Date(now.getTime() - 30 * DAY_MS);
        const usage = await rows.usage(candidate.ownerUserId, utcDay, periodStart);
        if (usage.inFlight) return blocked('OWNER_IN_FLIGHT');
        if (usage.dayRuns >= Math.min(rule.maxRunsPerDay, connection.maxRunsPerDay)
          || usage.periodCents + reserveCents > Math.min(rule.periodBudgetCents, connection.periodBudgetCents))
          return refuse('BUDGET_EXHAUSTED');
        if (!await rows.reserve(candidate.id, connection.id, reserveCents, now)) return blocked('NOT_QUEUED');
        return { status: 'reserved', id: candidate.id, ownerUserId: candidate.ownerUserId,
          ruleId: candidate.ruleId, resultId: candidate.resultId, connectionId: connection.id,
          reservedCents: reserveCents };
      });
    },
  };
}
