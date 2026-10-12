import { AI_PROVIDERS, aiModelCallsTools, PERSONAL_RUN_LIMITS, type AiWireFormat } from '@flux/contracts';
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

/** A tool name both wire formats accept (Anthropic allows 128, OpenAI 64: the shorter bound serves both). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** More tools than this are never offered: the definitions are part of every request's input. */
const MAX_TOOLS = 64;

function checkTools(request: PersonalComputeRequest) {
  const { tools, turns } = request;
  if (!tools?.length) {
    // Earlier turns without tools would be a conversation the provider cannot continue.
    if (turns?.length) throw new Error('Earlier turns need the tools they used');
    return;
  }
  if (!aiModelCallsTools(request.connection.provider, request.model)) throw new Error('This model cannot call tools');
  if (tools.length > MAX_TOOLS) throw new Error('Too many tools');
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name)) throw new Error('A tool name is invalid or repeated');
    names.add(tool.name);
    if (typeof tool.description !== 'string' || typeof tool.inputSchema !== 'object' || tool.inputSchema === null
      || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('A tool definition is invalid');
  }
  if ((turns?.length ?? 0) > PERSONAL_RUN_LIMITS.maxTurns - 1) throw new Error('Too many turns');
  for (const turn of turns ?? []) {
    const called = new Set(turn.calls.map((call) => call.id));
    const answered = new Set(turn.results.map((result) => result.callId));
    if (!turn.calls.length || called.size !== turn.calls.length || called.size !== answered.size || turn.results.length !== answered.size
      || [...called].some((id) => !answered.has(id))) throw new Error('Every tool call of a turn needs exactly one result');
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
  checkTools(request);
}
