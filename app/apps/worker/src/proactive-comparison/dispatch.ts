import { randomUUID } from 'node:crypto';
import { COMPARISON_CONTEXT_LIMITS, openBackgroundKey, proactiveOutboxRows } from '@flux/db';
import { BACKGROUND_COMPARISON_MAX_INPUT_TOKENS, BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS, boundedInputTokens,
  comparisonInputEstimate, ComparisonNotSentError, comparisonObservedUsage, insufficientComparisonReason, validateComparisonResponse,
  type ComparisonProvider, type ComparisonSource, type Database } from '@flux/core';
import { proactiveReservation } from './reservation-adapter.js';
import { abortableComparisonCall, authorizedComparison, ComparisonStopped as Stop, watchComparisonAuthorization,
  type ObservedUsage } from './authorization.js';

type Outcome =
  | { status: 'proposal'; proposalId: string }
  | { status: 'insufficient_evidence'; outcomeId: string }
  | { status: 'blocked'; reason: string }
  | { status: 'not_run'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * Bounded dispatch of one ready candidate, called by the comparison worker's tick when the
 * operator switched background comparisons on (#58), and by tests. Provider calls do not hold SQL
 * locks. The request
 * goes to the owner's connection, whatever its provider (F-020): `provider` is the adapter registry
 * (`providerComparison` of `@flux/agent-runtime`) or a test double.
 */
export async function dispatchProactiveComparison(input: { db: Database; candidateId: string;
  masterKey: Buffer | null; provider: ComparisonProvider }): Promise<Outcome> {
  const existing = await proactiveOutboxRows(input.db).proposalForCandidate(input.candidateId);
  if (existing) return { status: 'proposal', proposalId: existing.id };
  const insufficient = await proactiveOutboxRows(input.db).insufficientForCandidate(input.candidateId);
  if (insufficient) return { status: 'insufficient_evidence', outcomeId: insufficient.id };
  if (!input.masterKey) return input.db.transaction(async (tx) => {
    const rows = proactiveOutboxRows(tx);
    const candidate = await rows.lockCandidate(input.candidateId);
    if (!candidate || candidate.status !== 'queued') return { status: 'blocked', reason: 'NOT_QUEUED' } as const;
    await rows.markNotRun(candidate.id, 'KEY_UNAVAILABLE');
    return { status: 'not_run', reason: 'KEY_UNAVAILABLE' } as const;
  });
  const reservation = await proactiveReservation(input.db).reserve(input.candidateId);
  if (reservation.status === 'blocked') return reservation.reason === 'NOT_QUEUED' || reservation.reason === 'OWNER_IN_FLIGHT' || reservation.reason === 'QUIET_WINDOW'
    ? reservation : { status: 'not_run', reason: reservation.reason };
  let watch: ReturnType<typeof watchComparisonAuthorization> | undefined;
  let usage: ObservedUsage | undefined;
  let paidRequestStarted = false;
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
        const conversationId = source.type === 'message' ? await rows.messageConversation(candidate.projectId, source.id) : null;
        if (source.type === 'message' && !conversationId) throw new Stop('SOURCE_CHANGED');
        const cap = COMPARISON_CONTEXT_LIMITS.excerptCharacters;
        selected.push({ type: source.type, id: source.id, version: revision, ...(source.sketchId ? { sketchId: source.sketchId } : {}),
          ...(conversationId ? { conversationId } : {}),
          title: text.split('\n', 1)[0]!.trim().slice(0, 100),
          text: text.length > cap ? `${text.slice(0, cap)}\n[Excerpt: remaining source text was omitted.]` : text,
          ...(text.length > cap ? { excerpted: true, originalCharacters: text.length } : {}) });
      }
      const sources = [...new Map(selected.map((source) => [`${source.type}:${source.id}:${source.version}`, source])).values()];
      const connection = await rows.connection(candidate.ownerUserId);
      if (connection?.id !== reservation.connectionId || !connection.encryptedKey) throw new Stop('AUTHORIZATION_CHANGED');
      if (connection.inputPriceMicrosPerMTok === null || connection.outputPriceMicrosPerMTok === null) throw new Stop('CONNECTION_PRICE_UNKNOWN');
      await rows.saveInspected(candidate.id, sources.map((source) => ({ type: source.type, id: source.id,
        version: source.version, title: source.title ?? '', ...(source.conversationId ? { conversationId: source.conversationId } : {}),
        ...(source.sketchId ? { sketchId: source.sketchId } : {}), ...(source.excerpted
          ? { excerpted: true, originalCharacters: source.originalCharacters } : {}) })));
      let apiKey: string;
      try { apiKey = openBackgroundKey(connection.encryptedKey, candidate.ownerUserId, connection.id, input.masterKey!); }
      catch { throw new Stop('KEY_UNAVAILABLE'); }
      return { apiKey, sources, ruleVersion: rule.version,
        target: { provider: connection.provider, model: connection.model, baseUrl: connection.baseUrl },
        price: { inputMicrosPerMTok: connection.inputPriceMicrosPerMTok, outputMicrosPerMTok: connection.outputPriceMicrosPerMTok } };
    });
    watch = watchComparisonAuthorization(input.db, input.candidateId, reservation.connectionId, prepared.ruleVersion);
    const signal = AbortSignal.any([watch.signal, AbortSignal.timeout(20_000)]);
    const providerInput = { apiKey: prepared.apiKey, ...prepared.target, sources: prepared.sources, signal } as const;
    await watch.check();
    // The same conservative Flux estimate bounds every provider; a provider count may only raise it (PROV-3).
    const estimate = comparisonInputEstimate(prepared.sources);
    if (estimate > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS) throw new Stop('INPUT_TOKEN_LIMIT');
    const counted = input.provider.countInputTokens
      ? await abortableComparisonCall(signal, () => input.provider.countInputTokens!(providerInput)) : null;
    if (counted !== null && (!Number.isInteger(counted) || counted < 0)) throw new Stop('INPUT_TOKEN_LIMIT');
    if (boundedInputTokens(estimate, counted) > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS) throw new Stop('INPUT_TOKEN_LIMIT');
    // A pause during token counting must not start a paid message request.
    await watch.check();
    await input.db.transaction(async (tx) => {
      const { rows, candidate } = await authorizedComparison(tx, input.candidateId,
        reservation.connectionId, prepared.ruleVersion, true);
      await rows.markDispatchStarted(candidate.id);
    });
    await watch.check();
    const response = await abortableComparisonCall(signal, () => {
      // Set this inside the abortable callback: an abort before adapter entry made no request.
      paidRequestStarted = true;
      return input.provider.createMessage({ ...providerInput,
        maxTokens: BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS, effort: 'low' });
    });
    usage = comparisonObservedUsage(response, prepared.price) ?? undefined;
    const answer = validateComparisonResponse(response, prepared.sources);
    if (!usage) throw new Stop('INVALID_OBSERVED_USAGE');
    const observed = usage;
    return await input.db.transaction(async (tx): Promise<Outcome> => {
      const { rows, candidate, rule, connection } = await authorizedComparison(tx, input.candidateId,
        reservation.connectionId, prepared.ruleVersion, true);
      if (observed.estimatedCents > Math.min(rule.perRunCents, connection.perRunCents))
        throw new Stop('OBSERVED_COST_OVER_CEILING', observed);
      if (!answer) {
        const created = await rows.completeInsufficient({ candidateId: candidate.id, id: randomUUID(),
          ownerUserId: candidate.ownerUserId, agentId: rule.agentId, projectId: candidate.projectId,
          resultId: candidate.resultId, reason: insufficientComparisonReason(response),
          failureCode: response.stopReason === 'end_turn' && response.answer?.kind === 'insufficient_evidence'
            ? 'INSUFFICIENT_EVIDENCE' : 'INVALID_OR_TRUNCATED_RESPONSE', ...observed });
        if (!created) throw new Stop('RESERVATION_CHANGED', observed);
        return { status: 'insufficient_evidence', outcomeId: created.id };
      }
      const cited = await Promise.all(answer.citations.map(async (citation) => {
        if (citation.type !== 'message') return citation;
        const conversationId = await rows.messageConversation(candidate.projectId, citation.id);
        if (!conversationId) throw new Stop('SOURCE_CHANGED_AFTER_RESPONSE', usage);
        return { ...citation, conversationId };
      }));
      const created = await rows.complete({ candidateId: candidate.id, id: randomUUID(), ownerUserId: candidate.ownerUserId,
        agentId: rule.agentId, projectId: candidate.projectId, resultId: candidate.resultId,
        sourceFingerprint: candidate.sourceFingerprint, sources: cited,
        provider: prepared.target.provider, model: prepared.target.model,
        fact: answer.fact, interpretation: answer.interpretation, suggestedAction: answer.suggestedAction,
        inputTokens: observed.inputTokens, outputTokens: observed.outputTokens, estimatedCents: observed.estimatedCents });
      if (!created) throw new Stop('RESERVATION_CHANGED', observed);
      return { status: 'proposal', proposalId: created.id };
    });
  } catch (error) {
    const stopped = error instanceof Stop ? error : error instanceof ComparisonNotSentError ? new Stop(error.code)
      : new Stop('PROVIDER_OR_STORAGE_FAILURE');
    // An adapter that refused before sending (an endpoint the policy no longer allows) made no request.
    if (!paidRequestStarted || error instanceof ComparisonNotSentError) {
      await proactiveOutboxRows(input.db).markNotRun(input.candidateId, stopped.code);
      return { status: 'not_run', reason: stopped.code };
    }
    await proactiveOutboxRows(input.db).markUnknown(input.candidateId, stopped.code, stopped.usage ?? usage);
    return { status: 'unknown', reason: stopped.code };
  } finally {
    await watch?.stop();
  }
}
