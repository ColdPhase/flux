import { maxRequestMicros } from '@flux/contracts';
import { boundedUsageMicros, conservativeTokenEstimate, type PersonalCompute, type PersonalComputeRequest, type PersonalTool, type ToolCheck, type ToolCheckProbe, type ToolCheckResult } from '@flux/core';
import { providerPersonalCompute, type ProviderRegistryOptions } from './registry.js';
import type { PersonalKeyResolver } from './limits.js';

// The one check that decides whether a model can be an agent (RT-1 rule 2, #1441): one small request on the model with one tool, `ping`, that
// the model is asked to call, the same for every provider (the adapter of its wire format writes it). No table of models, no owner's switch.

/** The tool the model is asked to call. It takes nothing and does nothing: the call is the answer. */
export const PING_TOOL: PersonalTool = { name: 'ping', description: 'Answer the check. Call this tool once.', inputSchema: { type: 'object', properties: {} } };
const CHECK_SYSTEM = 'You are being checked by Flux. Call the ping tool now. Do not write anything else.';
const CHECK_INPUT = 'ping';
/** The output bound of the check: a call is a few tokens, so this is room for a little thinking and it bounds the check's largest cost. */
const CHECK_MAX_TOKENS = 256;
/**
 * What a provider adds to the input of a request that offers tools beyond its words (Anthropic's own tool-use prompt is about 350 tokens, the
 * chat templates of the others add some): room above the conservative estimate of the words, so a usage the provider reports within it is
 * charged as reported, and the most a check can cost is not below what the provider really bills.
 */
const PROVIDER_INPUT_OVERHEAD_TOKENS = 1_000;
/** The key reference of a key that is only being added: the check's own compute resolves it to that key, and to no other. */
const NEW_KEY_REF = 'key-being-added';
/** A check that waits longer than this is a failed one; it is also shorter than a database session may idle inside a transaction (60 s). */
export const TOOL_CHECK_TIMEOUT_MS = 30_000;

/** The most input tokens a check may report: the estimate of its words and the provider's own overhead. */
const maxCheckInputTokens = () => conservativeTokenEstimate([CHECK_SYSTEM, CHECK_INPUT, JSON.stringify(PING_TOOL)]) + PROVIDER_INPUT_OVERHEAD_TOKENS;

/** The most one check can cost at `price` (PROV-3): what it is charged when its cost cannot be known. */
export const largestToolCheckMicros = (price: ToolCheckProbe['price']): number => maxRequestMicros(price, maxCheckInputTokens(), CHECK_MAX_TOKENS);

/**
 * Sends the check through `compute` and says whether the model called `ping`, and what the request cost: the provider's usage at the model's
 * price when the answer came (never above the request's largest cost), nothing when the provider documents no charge for the failure
 * (`billed: 'none'`), else the most the request could have cost. A request that failed or was refused is a model that cannot be an agent.
 */
export async function checkToolCalling(compute: PersonalCompute, probe: ToolCheckProbe, signal: AbortSignal = AbortSignal.timeout(TOOL_CHECK_TIMEOUT_MS + 10_000)): Promise<ToolCheckResult> {
  const keyRef = 'connectionId' in probe.key ? probe.key.connectionId : NEW_KEY_REF;
  const request: PersonalComputeRequest = {
    connection: { id: keyRef, keyRef, provider: probe.provider, baseUrl: probe.baseUrl },
    model: probe.model, maxTokens: CHECK_MAX_TOKENS, effort: 'low', system: CHECK_SYSTEM, input: CHECK_INPUT, tools: [PING_TOOL],
  };
  const largest = largestToolCheckMicros(probe.price);
  const result = await compute.dispatch(request, signal).catch((): null => null);
  if (!result) return { callsTools: false, chargedMicros: largest };
  if (result.kind === 'failed') return { callsTools: false, chargedMicros: result.billed === 'none' ? 0 : largest };
  const charged = boundedUsageMicros(probe.price, result.usage, { maxInputTokens: maxCheckInputTokens(), maxOutputTokens: CHECK_MAX_TOKENS, reservedMicros: largest }) ?? largest;
  return { callsTools: !!result.toolCalls?.some((call) => call.name === PING_TOOL.name), chargedMicros: charged };
}

/**
 * The server's check over the provider adapters: a key being added is opened by the closure of that one call and no other, a stored key by
 * `resolveStoredKey` (the sealed key of a connection, opened for this one request; absent: a stored key cannot be checked). The transport
 * and the endpoint policy are those of every adapter; `timeoutMs` bounds each request.
 */
export function providerToolCheck(options: Omit<ProviderRegistryOptions, 'timeoutMs'> & { resolveStoredKey?: PersonalKeyResolver | null; timeoutMs?: number }): ToolCheck {
  const { resolveStoredKey = null, timeoutMs = TOOL_CHECK_TIMEOUT_MS, ...registry } = options;
  const stored = providerPersonalCompute({ ...registry, timeoutMs, enabled: !!resolveStoredKey, resolveKey: resolveStoredKey ?? (async () => null) });
  return (probe) => {
    if ('connectionId' in probe.key) return checkToolCalling(stored, probe);
    const { apiKey } = probe.key;
    const own = providerPersonalCompute({ ...registry, timeoutMs, enabled: true, resolveKey: async (keyRef) => (keyRef === NEW_KEY_REF ? apiKey : null) });
    return checkToolCalling(own, probe);
  };
}
