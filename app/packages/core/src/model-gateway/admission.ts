import type { AiProviderKind } from '@flux/contracts';

// What one request through the model gateway may ask (#1441, docs/product/ai-modes.md "The model gateway"). The money held for a
// request is worked out from its body before it is sent, so the body must say everything it can cost: the run's own model, an output
// bound, only the harness's own function tools, one answer, and no state kept at the provider. Pure: the body is the harness's, so
// every field read here is checked for its type.

/** The wire format of a request (`ModelGatewayOperation` of `@flux/runtime-protocol`). */
export type GatewayOperation = 'anthropic_messages' | 'openai_chat' | 'openai_responses' | 'gemini_generate';

/** The bounds admission applies (`MODEL_GATEWAY_LIMITS` of `@flux/runtime-protocol`). */
export interface GatewayAdmissionLimits {
  maxOutputTokens: number;
  inputAllowanceTokens: number;
  pictureTokens: number;
}

export interface GatewayRequestFacts {
  provider: AiProviderKind;
  operation: GatewayOperation;
  /** The model a Gemini native path names; null when the body names it. */
  pathModel: string | null;
  /** Gemini native: whether the path streams; null when the body says. */
  pathStream: boolean | null;
}

export interface AdmittedRequest {
  /** The body as it is sent: the output bound set, and a stream asked to report its usage. */
  body: Buffer;
  stream: boolean;
  /** Anthropic: the request marks something for the prompt cache (`cache_control`), so cache reads cost their rate (#1410). */
  cacheAsked: boolean;
  maxOutputTokens: number;
  /** The most input tokens it can be billed for: one per byte of the body, the allowance, and the pictures' allowance. */
  inputBoundTokens: number;
}

export type Admission = { ok: true; request: AdmittedRequest } | { ok: false; message: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const refuse = (message: string): Admission => ({ ok: false, message });
const wholeAtLeastOne = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** A Gemini model id with or without its `models/` prefix. */
const geminiModel = (model: string) => model.replace(/^models\//, '');

/** Facts found anywhere in the body: pictures (each may cost more tokens than its bytes), cache marks and what Flux refuses. */
interface Scan { pictures: number; cacheAsked: boolean; refused: string | null }

const MAX_DEPTH = 64;

function scan(value: unknown, operation: GatewayOperation, found: Scan, depth = 0): void {
  if (found.refused) return;
  if (depth > MAX_DEPTH) { found.refused = 'The request is nested too deeply'; return; }
  if (Array.isArray(value)) { for (const item of value) scan(item, operation, found, depth + 1); return; }
  if (!isObject(value)) return;
  if ('cache_control' in value) found.cacheAsked = true;
  // Content the provider would fetch or keep itself is not in the body, so what it costs cannot be bounded from the body.
  const source = value.source;
  if (isObject(source) && (source.type === 'url' || source.type === 'file')) { found.refused = 'Only content inside the request can be sent: no URL or file references'; return; }
  if ('fileData' in value || 'file_id' in value || 'file_url' in value) { found.refused = 'Only content inside the request can be sent: no URL or file references'; return; }
  // A file's tokens (a PDF's pages) are not bounded by its bytes; a harness sends its text instead.
  if ('file_data' in value || (value.type === 'document' && isObject(source) && source.type === 'base64')) { found.refused = 'Files are not sent through Flux: send their text'; return; }
  const imageUrl = value.image_url;
  const imageAddress = typeof imageUrl === 'string' ? imageUrl : isObject(imageUrl) && typeof imageUrl.url === 'string' ? imageUrl.url : null;
  if (imageAddress !== null && !imageAddress.startsWith('data:')) { found.refused = 'Only pictures inside the request can be sent'; return; }
  if (imageAddress !== null || value.type === 'image' || value.type === 'input_image' || 'inlineData' in value || 'inline_data' in value) found.pictures += 1;
  for (const item of Object.values(value)) scan(item, operation, found, depth + 1);
}

/** Only the harness's own function tools: a provider's hosted tools (search, code, files, connectors, computer use) cost what the body cannot say. */
function toolsRefusal(body: Json, operation: GatewayOperation): string | null {
  const tools = body.tools;
  if (tools !== undefined && !Array.isArray(tools)) return 'tools must be a list';
  for (const tool of (tools ?? []) as unknown[]) {
    if (!isObject(tool)) return 'A tool must be an object';
    if (operation === 'anthropic_messages' && tool.type !== undefined && tool.type !== 'custom') return `The provider's own tool ${String(tool.type)} is not offered through Flux`;
    if ((operation === 'openai_chat' || operation === 'openai_responses') && tool.type !== 'function' && tool.type !== 'custom') return `The provider's own tool ${String(tool.type)} is not offered through Flux`;
    if (operation === 'gemini_generate' && Object.keys(tool).some((key) => key !== 'functionDeclarations')) return 'Only function declarations are offered through Flux';
  }
  if (operation === 'anthropic_messages' && (body.mcp_servers !== undefined || body.container !== undefined)) return 'Provider-side connectors and containers are not offered through Flux';
  if (operation === 'openai_chat' && (body.web_search_options !== undefined || body.plugins !== undefined)) return 'The provider\'s own web search is not offered through Flux';
  return null;
}

/** Sets the output bound to at most `max` (and to `max` when there is none); refuses one that is not a whole number. */
function bound(holder: Json, key: string, max: number, required: boolean): number | string {
  const value = holder[key];
  if (value === undefined || value === null) {
    if (!required) return 0;
    holder[key] = max;
    return max;
  }
  if (!wholeAtLeastOne(value)) return `${key} must be a whole number of at least 1`;
  holder[key] = Math.min(value, max);
  return holder[key] as number;
}

/**
 * Whether a request may go through the gateway on a run of `runModel`, and the body that is sent. Refused: another model, a body
 * that is no JSON object, hosted tools, several answers, content or state kept at the provider, and output bounds that are not
 * whole numbers. An output bound above the limit, or none, is set to the limit.
 */
export function admitGatewayRequest(facts: GatewayRequestFacts, raw: Buffer, runModel: string, limits: GatewayAdmissionLimits): Admission {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return refuse('The request body is not JSON'); }
  if (!isObject(body)) return refuse('The request body is not a JSON object');
  const { operation, provider } = facts;

  if (operation === 'gemini_generate') {
    if (!facts.pathModel || geminiModel(facts.pathModel) !== geminiModel(runModel)) return refuse(`This run uses the model ${runModel}`);
    if (body.model !== undefined && (typeof body.model !== 'string' || geminiModel(body.model) !== geminiModel(runModel))) return refuse(`This run uses the model ${runModel}`);
    if (body.cachedContent !== undefined) return refuse('Content cached at the provider cannot be sent through Flux');
  } else if (body.model !== runModel) return refuse(`This run uses the model ${runModel}`);

  const tools = toolsRefusal(body, operation);
  if (tools) return refuse(tools);
  const found: Scan = { pictures: 0, cacheAsked: false, refused: null };
  scan(body, operation, found);
  if (found.refused) return refuse(found.refused);

  const max = limits.maxOutputTokens;
  let output: number | string;
  let stream: boolean;
  switch (operation) {
    case 'anthropic_messages':
      output = bound(body, 'max_tokens', max, true);
      stream = body.stream === true;
      break;
    case 'openai_chat': {
      if (body.n !== undefined && body.n !== 1) return refuse('Only one answer at a time can be asked for');
      const completion = bound(body, 'max_completion_tokens', max, false);
      const legacy = bound(body, 'max_tokens', max, false);
      if (typeof completion === 'string') return refuse(completion);
      if (typeof legacy === 'string') return refuse(legacy);
      // Without either, the provider's own name for the bound: OpenAI's current one, or the one every compatible server reads.
      const given = [completion, legacy].filter((value) => value > 0);
      output = given.length ? Math.min(...given) : (bound(body, provider === 'openai' ? 'max_completion_tokens' : 'max_tokens', max, true) as number);
      stream = body.stream === true;
      if (stream) body.stream_options = { ...(isObject(body.stream_options) ? body.stream_options : {}), include_usage: true };
      // OpenRouter reports each answer's cost, which reconciles the charge (CA-3).
      if (provider === 'openrouter') body.usage = { include: true };
      break;
    }
    case 'openai_responses':
      if (body.background !== undefined && body.background !== false) return refuse('Background answers are not offered through Flux');
      if (body.previous_response_id !== undefined && body.previous_response_id !== null) return refuse('Send the whole conversation: answers kept at the provider are not offered through Flux');
      if (body.conversation !== undefined && body.conversation !== null) return refuse('Send the whole conversation: conversations kept at the provider are not offered through Flux');
      output = bound(body, 'max_output_tokens', max, true);
      stream = body.stream === true;
      break;
    case 'gemini_generate': {
      const config = body.generationConfig === undefined ? (body.generationConfig = {}) : body.generationConfig;
      if (!isObject(config)) return refuse('generationConfig must be an object');
      if (config.candidateCount !== undefined && config.candidateCount !== 1) return refuse('Only one answer at a time can be asked for');
      output = bound(config, 'maxOutputTokens', max, true);
      stream = facts.pathStream === true;
      break;
    }
  }
  if (typeof output === 'string') return refuse(output);
  const sent = Buffer.from(JSON.stringify(body), 'utf8');
  return { ok: true, request: {
    body: sent, stream, cacheAsked: operation === 'anthropic_messages' && found.cacheAsked, maxOutputTokens: output,
    inputBoundTokens: Math.max(raw.byteLength, sent.byteLength) + limits.inputAllowanceTokens + found.pictures * limits.pictureTokens,
  } };
}
