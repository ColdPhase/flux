import { randomUUID } from 'node:crypto';
import { openBackgroundKey, proactiveOutboxRows } from '@flux/db';
import { BACKGROUND_COMPARISON_MAX_INPUT_TOKENS, BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS,
  BACKGROUND_COMPARISON_MODEL, estimatedUsageCents, evaluateProject, validateComparisonResponse,
  type ComparisonProvider, type ComparisonSource, type Database } from '@flux/core';
import { proactiveReservation } from './reservation-adapter.js';

type Outcome =
  | { status: 'proposal'; proposalId: string }
  | { status: 'blocked'; reason: string }
  | { status: 'unknown'; reason: string };

class Stop extends Error {
  constructor(readonly code: string, readonly usage?: { inputTokens: number; outputTokens: number; estimatedCents: number }) { super(code); }
}

/**
 * Explicitly invoked, bounded dispatch slice for a controlled provider. It is not registered
 * as a scheduled worker: production rule activation stays unavailable until the real provider,
 * cancellation, source set and UI pass the full #58 contract.
 */
export async function dispatchProactiveComparison(input: { db: Database; candidateId: string;
  masterKey: Buffer | null; provider: ComparisonProvider }): Promise<Outcome> {
  if (!input.masterKey) return { status: 'blocked', reason: 'KEY_UNAVAILABLE' };
  const existing = await proactiveOutboxRows(input.db).proposalForCandidate(input.candidateId);
  if (existing) return { status: 'proposal', proposalId: existing.id };
  const reservation = await proactiveReservation(input.db).reserve(input.candidateId);
  if (reservation.status === 'blocked') return reservation;
  try {
    const proposal = await input.db.transaction(async (tx) => {
      const rows = proactiveOutboxRows(tx);
      const candidate = await rows.lockCandidate(input.candidateId);
      if (!candidate || candidate.status !== 'reserved' || candidate.connectionId !== reservation.connectionId)
        throw new Stop('RESERVATION_CHANGED');
      await rows.lockOwner(candidate.ownerUserId);
      const rule = await rows.rule(candidate.ruleId);
      const result = await rows.result(candidate.resultId);
      const connection = await rows.connection(candidate.ownerUserId);
      if (!rule || rule.status !== 'enabled' || rule.ownerUserId !== candidate.ownerUserId
        || rule.projectId !== candidate.projectId || !result || result.projectId !== candidate.projectId
        || result.finding !== 'negative' || result.createdByKind !== 'human'
        || !connection || connection.id !== candidate.connectionId || !connection.encryptedKey)
        throw new Stop('AUTHORIZATION_CHANGED');
      const owner = await evaluateProject({ kind: 'human', id: candidate.ownerUserId }, 'project.write', candidate.projectId, tx, { lock: true });
      const agent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', candidate.projectId, tx, { lock: true });
      if (!owner.allowed || !agent.allowed || agent.actor?.agent?.ownerUserId !== candidate.ownerUserId)
        throw new Stop('ACCESS_CHANGED');

      const snapshot = await rows.sourceSnapshot(candidate.resultId);
      if (snapshot.fingerprint !== candidate.sourceFingerprint) throw new Stop('SOURCE_CHANGED');
      const selected: ComparisonSource[] = [{ type: 'result', id: result.id, version: 1,
        text: `${result.title}\n${result.evidence}` }];
      for (const source of snapshot.sources) {
        if (source.type !== 'result' && source.type !== 'message' && source.type !== 'material')
          throw new Stop('SOURCE_SCOPE_UNVERIFIED');
        if (source.type === 'material' && (!source.version || source.version < 1))
          throw new Stop('SOURCE_SCOPE_UNVERIFIED');
        if (!await rows.sourceCurrent(candidate.projectId, source)) throw new Stop('SOURCE_CHANGED');
        const revision = source.type === 'material' ? source.version! : 1;
        const text = await rows.sourceText(candidate.projectId, { type: source.type, id: source.id, version: revision });
        if (text === null) throw new Stop('SOURCE_CHANGED');
        selected.push({ type: source.type, id: source.id, version: revision, text });
      }
      const sources = [...new Map(selected.map((source) => [`${source.type}:${source.id}:${source.version}`, source])).values()];
      if (sources.some((source) => source.text.length > 20_000)) throw new Stop('INPUT_TOO_LARGE');
      const apiKey = openBackgroundKey(connection.encryptedKey, candidate.ownerUserId, connection.id, input.masterKey!);
      const signal = AbortSignal.timeout(20_000);
      const providerInput = { apiKey, model: BACKGROUND_COMPARISON_MODEL, sources, signal } as const;
      const counted = await input.provider.countInputTokens(providerInput);
      if (!Number.isInteger(counted) || counted < 0 || counted > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS)
        throw new Stop('INPUT_TOKEN_LIMIT');
      // The policy/source rows stay locked until this one controlled call and proposal commit.
      // That prevents a revocation or source edit from committing between check and publication.
      const response = await input.provider.createMessage({ ...providerInput,
        maxTokens: BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS, effort: 'low' });
      const usage = response?.usage && Number.isSafeInteger(response.usage.inputTokens)
        && response.usage.inputTokens >= 0 && response.usage.inputTokens <= BACKGROUND_COMPARISON_MAX_INPUT_TOKENS
        && Number.isSafeInteger(response.usage.outputTokens) && response.usage.outputTokens >= 0
        && response.usage.outputTokens <= BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS
        ? { ...response.usage, estimatedCents: estimatedUsageCents(response.usage.inputTokens, response.usage.outputTokens) }
        : undefined;
      const answer = validateComparisonResponse(response, sources);
      if (!answer || !usage || response.usage.inputTokens > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS)
        throw new Stop('INVALID_OR_TRUNCATED_RESPONSE', usage);
      if (usage.estimatedCents > Math.min(rule.perRunCents, connection.perRunCents))
        throw new Stop('OBSERVED_COST_OVER_CEILING', usage);
      // Re-evaluate while the same locks are held; this is the final publication gate.
      const finalOwner = await evaluateProject({ kind: 'human', id: candidate.ownerUserId }, 'project.write', candidate.projectId, tx, { lock: true });
      const finalAgent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', candidate.projectId, tx, { lock: true });
      if (!finalOwner.allowed || !finalAgent.allowed || finalAgent.actor?.agent?.ownerUserId !== candidate.ownerUserId)
        throw new Stop('ACCESS_CHANGED_AFTER_RESPONSE', usage);
      const finalSnapshot = await rows.sourceSnapshot(candidate.resultId);
      if (finalSnapshot.fingerprint !== candidate.sourceFingerprint) throw new Stop('SOURCE_CHANGED_AFTER_RESPONSE', usage);
      for (const source of finalSnapshot.sources) if (!await rows.sourceCurrent(candidate.projectId, source))
        throw new Stop('SOURCE_CHANGED_AFTER_RESPONSE', usage);
      const created = await rows.complete({ candidateId: candidate.id, id: randomUUID(), ownerUserId: candidate.ownerUserId,
        agentId: rule.agentId, projectId: candidate.projectId, resultId: candidate.resultId,
        sourceFingerprint: candidate.sourceFingerprint, sources: answer.citations,
        fact: answer.fact, interpretation: answer.interpretation, suggestedAction: answer.suggestedAction,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCents: usage.estimatedCents });
      if (!created) throw new Stop('RESERVATION_CHANGED', usage);
      return created;
    });
    return { status: 'proposal', proposalId: proposal.id };
  } catch (error) {
    const stopped = error instanceof Stop ? error : new Stop('PROVIDER_OR_STORAGE_FAILURE');
    await proactiveOutboxRows(input.db).markUnknown(input.candidateId, stopped.code, stopped.usage);
    return { status: 'unknown', reason: stopped.code };
  }
}
