import { randomUUID } from 'node:crypto';
import { COMPARISON_CONTEXT_LIMITS, openBackgroundKey, proactiveOutboxRows } from '@flux/db';
import { BACKGROUND_COMPARISON_MAX_INPUT_TOKENS, BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS,
  BACKGROUND_COMPARISON_MODEL, estimatedUsageCents, validateComparisonResponse,
  type ComparisonProvider, type ComparisonSource, type Database } from '@flux/core';
import { proactiveReservation } from './reservation-adapter.js';
import { abortableComparisonCall, authorizedComparison, ComparisonStopped as Stop, watchComparisonAuthorization,
  type ObservedUsage } from './authorization.js';

type Outcome =
  | { status: 'proposal'; proposalId: string }
  | { status: 'blocked'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * Explicitly invoked, bounded dispatch slice for a controlled provider. It is not registered
 * as a scheduled worker: production rule activation stays unavailable until the real provider,
 * source set and UI pass the full #58 contract. Provider calls do not hold SQL locks.
 */
export async function dispatchProactiveComparison(input: { db: Database; candidateId: string;
  masterKey: Buffer | null; provider: ComparisonProvider }): Promise<Outcome> {
  if (!input.masterKey) return { status: 'blocked', reason: 'KEY_UNAVAILABLE' };
  const existing = await proactiveOutboxRows(input.db).proposalForCandidate(input.candidateId);
  if (existing) return { status: 'proposal', proposalId: existing.id };
  const reservation = await proactiveReservation(input.db).reserve(input.candidateId);
  if (reservation.status === 'blocked') return reservation;
  let watch: ReturnType<typeof watchComparisonAuthorization> | undefined;
  let usage: ObservedUsage | undefined;
  try {
    const prepared = await input.db.transaction(async (tx) => {
      const { rows, candidate, rule, snapshot } =
        await authorizedComparison(tx, input.candidateId, reservation.connectionId, undefined, true);
      const selected: ComparisonSource[] = [];
      for (const source of snapshot.sources) {
        if (source.type !== 'result' && source.type !== 'message' && source.type !== 'material' && source.type !== 'work' && source.type !== 'thought')
          throw new Stop('SOURCE_SCOPE_UNVERIFIED');
        if (!source.version || source.version < 1)
          throw new Stop('SOURCE_SCOPE_UNVERIFIED');
        if (!await rows.sourceCurrent(candidate.projectId, source)) throw new Stop('SOURCE_CHANGED');
        const revision = source.version;
        const text = await rows.sourceText(candidate.projectId, { type: source.type, id: source.id, version: revision });
        if (text === null) throw new Stop('SOURCE_CHANGED');
        const cap = COMPARISON_CONTEXT_LIMITS.excerptCharacters;
        selected.push({ type: source.type, id: source.id, version: revision, ...(source.sketchId ? { sketchId: source.sketchId } : {}),
          text: text.length > cap ? `${text.slice(0, cap)}\n[Excerpt: remaining source text was omitted.]` : text,
          ...(text.length > cap ? { excerpted: true, originalCharacters: text.length } : {}) });
      }
      const sources = [...new Map(selected.map((source) => [`${source.type}:${source.id}:${source.version}`, source])).values()];
      const connection = await rows.connection(candidate.ownerUserId);
      if (connection?.id !== reservation.connectionId || !connection.encryptedKey) throw new Stop('AUTHORIZATION_CHANGED');
      const apiKey = openBackgroundKey(connection.encryptedKey, candidate.ownerUserId, connection.id, input.masterKey!);
      return { apiKey, sources, ruleVersion: rule.version };
    });
    watch = watchComparisonAuthorization(input.db, input.candidateId, reservation.connectionId, prepared.ruleVersion);
    const signal = AbortSignal.any([watch.signal, AbortSignal.timeout(20_000)]);
    const providerInput = { apiKey: prepared.apiKey, model: BACKGROUND_COMPARISON_MODEL, sources: prepared.sources, signal } as const;
    await watch.check();
    const counted = await abortableComparisonCall(signal, () => input.provider.countInputTokens(providerInput));
    if (!Number.isInteger(counted) || counted < 0 || counted > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS)
      throw new Stop('INPUT_TOKEN_LIMIT');
    // A pause during token counting must not start a paid message request.
    await watch.check();
    const response = await abortableComparisonCall(signal, () => input.provider.createMessage({ ...providerInput,
      maxTokens: BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS, effort: 'low' }));
    usage = response?.usage && Number.isSafeInteger(response.usage.inputTokens)
      && response.usage.inputTokens >= 0 && response.usage.inputTokens <= BACKGROUND_COMPARISON_MAX_INPUT_TOKENS
      && Number.isSafeInteger(response.usage.outputTokens) && response.usage.outputTokens >= 0
      && response.usage.outputTokens <= BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS
      ? { ...response.usage, estimatedCents: estimatedUsageCents(response.usage.inputTokens, response.usage.outputTokens) }
      : undefined;
    const answer = validateComparisonResponse(response, prepared.sources);
    if (!answer || !usage) throw new Stop('INVALID_OR_TRUNCATED_RESPONSE', usage);
    const observed = usage;
    const proposal = await input.db.transaction(async (tx) => {
      const { rows, candidate, rule, connection } = await authorizedComparison(tx, input.candidateId,
        reservation.connectionId, prepared.ruleVersion, true);
      if (observed.estimatedCents > Math.min(rule.perRunCents, connection.perRunCents))
        throw new Stop('OBSERVED_COST_OVER_CEILING', observed);
      const cited = await Promise.all(answer.citations.map(async (citation) => {
        if (citation.type !== 'message') return citation;
        const conversationId = await rows.messageConversation(candidate.projectId, citation.id);
        if (!conversationId) throw new Stop('SOURCE_CHANGED_AFTER_RESPONSE', usage);
        return { ...citation, conversationId };
      }));
      const created = await rows.complete({ candidateId: candidate.id, id: randomUUID(), ownerUserId: candidate.ownerUserId,
        agentId: rule.agentId, projectId: candidate.projectId, resultId: candidate.resultId,
        sourceFingerprint: candidate.sourceFingerprint, sources: cited,
        fact: answer.fact, interpretation: answer.interpretation, suggestedAction: answer.suggestedAction,
        inputTokens: observed.inputTokens, outputTokens: observed.outputTokens, estimatedCents: observed.estimatedCents });
      if (!created) throw new Stop('RESERVATION_CHANGED', observed);
      return created;
    });
    return { status: 'proposal', proposalId: proposal.id };
  } catch (error) {
    const stopped = error instanceof Stop ? error : new Stop('PROVIDER_OR_STORAGE_FAILURE');
    await proactiveOutboxRows(input.db).markUnknown(input.candidateId, stopped.code, stopped.usage ?? usage);
    return { status: 'unknown', reason: stopped.code };
  } finally {
    await watch?.stop();
  }
}
