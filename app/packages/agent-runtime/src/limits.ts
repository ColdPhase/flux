import { AI_PROVIDERS, PERSONAL_RUN_LIMITS, type AiWireFormat } from '@flux/contracts';
import { validModelId, type PersonalComputeRequest } from '@flux/core';

/** Turns a connection's `keyRef` into its key, or null when it cannot be used (#124 custody). */
export type PersonalKeyResolver = (keyRef: string) => Promise<string | null>;

/** The key could not be resolved: nothing was sent. */
export class PersonalKeyUnavailableError extends Error {
  constructor() {
    super('The personal connection has no usable key');
    this.name = 'PersonalKeyUnavailableError';
  }
}

/**
 * Refuses anything outside the O-008 request limits before a key is even resolved: the same
 * limits for every adapter (F-020 PROV-2). The model is the connection's own choice within the
 * bounded id format; the output bound and effort are fixed.
 */
export function checkRequestLimits(request: PersonalComputeRequest, wire: AiWireFormat) {
  if (AI_PROVIDERS[request.connection.provider]?.wire !== wire) throw new Error('The request was routed to another wire format');
  if (!validModelId(request.connection.provider, request.model)) throw new Error('The model id is outside the allowed format');
  if (request.maxTokens > PERSONAL_RUN_LIMITS.maxOutputTokens || request.maxTokens < 1) throw new Error('max_tokens exceeds the O-008 limit');
  if (request.effort !== PERSONAL_RUN_LIMITS.effort) throw new Error('Only low effort is allowed');
}
