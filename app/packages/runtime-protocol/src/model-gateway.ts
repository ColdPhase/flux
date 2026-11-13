// The model gateway's interface (#1441, docs/product/ai-modes.md "The model gateway"): how a harness in the runtime reaches its
// provider with an API key it never holds. The harness is given, for the run's provider, a base URL on runtime-egress's model port
// and its run's gateway token as the API key; the egress passes only the paths below on to the worker, which checks the token,
// holds the money, swaps in the key and sends the request to the provider. Both sides parse with this module, which sees bytes
// a compromised runtime controls, so it is small and strict. Node built-ins only (the slot image carries nothing else).

/** The providers of Connect AI, in the order of `AI_PROVIDER_KINDS` (`@flux/contracts`; a test keeps the two equal). */
export const MODEL_GATEWAY_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'] as const;
export type ModelGatewayProvider = (typeof MODEL_GATEWAY_PROVIDERS)[number];

/** The wire format of one request: what its body and its usage look like. */
export type ModelGatewayOperation = 'anthropic_messages' | 'openai_chat' | 'openai_responses' | 'gemini_generate';

/** runtime-egress's model port (where harnesses send) and the worker's gateway port (where the egress passes requests on). */
export const MODEL_GATEWAY_PORTS = { egress: 8081, worker: 8095 } as const;

/** How the runtime reaches the egress: plain HTTP on its own network, not through the CONNECT proxy (`NO_PROXY=runtime-egress`). */
export const MODEL_GATEWAY_ORIGIN = `http://runtime-egress:${MODEL_GATEWAY_PORTS.egress}`;

/**
 * The base URL a harness is given for each provider: the path its own client adds is appended to it (`/v1/messages`,
 * `/chat/completions`, `/responses`, `/v1beta/models/<model>:generateContent`). Gemini's OpenAI-compatible endpoint is
 * `…/gemini/v1beta/openai`.
 */
export const MODEL_GATEWAY_BASE_PATHS: Readonly<Record<ModelGatewayProvider, string>> = {
  anthropic: '/anthropic', openai: '/openai/v1', openrouter: '/openrouter/api/v1', gemini: '/gemini', openai_compatible: '/openai_compatible',
};

export const modelGatewayBaseUrl = (provider: ModelGatewayProvider, origin: string = MODEL_GATEWAY_ORIGIN): string => `${origin}${MODEL_GATEWAY_BASE_PATHS[provider]}`;

/**
 * Where a named provider's paths go: the path after the provider's segment is appended to this root. An OpenAI-compatible
 * endpoint's path goes to the owner's base URL instead.
 */
export const MODEL_GATEWAY_UPSTREAMS: Readonly<Record<Exclude<ModelGatewayProvider, 'openai_compatible'>, string>> = {
  anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', openrouter: 'https://openrouter.ai', gemini: 'https://generativelanguage.googleapis.com',
};

/** The environment variable a harness's token is handed over in (like the MCP run token's `FLUX_RUN_TOKEN`). */
export const MODEL_GATEWAY_TOKEN_ENV = 'FLUX_MODEL_GATEWAY_TOKEN';

/** A gateway token: `flux_mg_` and 32 random bytes in base64url. Only its SHA-256 is stored. */
export const MODEL_GATEWAY_TOKEN = /^flux_mg_[A-Za-z0-9_-]{43}$/;

/**
 * Technical safety bounds (#843's kind; docs/operations/agent-runtime.md "The model gateway"). `inputAllowanceTokens` and
 * `pictureTokens` widen a request's input bound (its body's bytes) for what a provider adds and for a picture, which may cost
 * more tokens than its bytes when it is small.
 */
export const MODEL_GATEWAY_LIMITS = {
  requestBytes: 16 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  headerBytes: 16 * 1024,
  requestMs: 10 * 60_000,
  idleMs: 2 * 60_000,
  maxOutputTokens: 32_000,
  concurrentPerRun: 4,
  inputAllowanceTokens: 1_024,
  pictureTokens: 5_000,
  errorBodyBytes: 64 * 1024,
  /** Request bodies of every run held in the worker's memory at once (#1441 review: the worker has 512 MiB for all its jobs). */
  bodiesInFlightBytes: 48 * 1024 * 1024,
} as const;

export interface ModelGatewayRoute {
  provider: ModelGatewayProvider;
  operation: ModelGatewayOperation;
  /** The path after the provider's segment, with its query (only Gemini's `?alt=sse`), as it is sent upstream. */
  path: string;
  /** The model a Gemini native path names; null elsewhere (the body names it). */
  model: string | null;
  /** Gemini native: whether the path streams. Null elsewhere (the body's `stream`). */
  stream: boolean | null;
}

const FIXED: Readonly<Record<ModelGatewayProvider, Readonly<Record<string, ModelGatewayOperation>>>> = {
  anthropic: { '/v1/messages': 'anthropic_messages' },
  openai: { '/v1/chat/completions': 'openai_chat', '/v1/responses': 'openai_responses' },
  openrouter: { '/api/v1/chat/completions': 'openai_chat' },
  gemini: { '/v1beta/openai/chat/completions': 'openai_chat' },
  openai_compatible: { '/chat/completions': 'openai_chat' },
};
const GEMINI_NATIVE = /^\/v1beta\/models\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}):(generateContent|streamGenerateContent)$/;
const URL_SHAPE = /^\/([a-z_]{1,32})(\/[A-Za-z0-9._:/-]{1,200})(?:\?([a-z=]{1,16}))?$/;

const isProvider = (value: string): value is ModelGatewayProvider => (MODEL_GATEWAY_PROVIDERS as readonly string[]).includes(value);

/** The route a request URL names, or null: an exact path of the provider's list; no `..`, no encoding, no other query. */
export function parseModelGatewayUrl(url: unknown): ModelGatewayRoute | null {
  if (typeof url !== 'string' || url.length > 300) return null;
  const match = URL_SHAPE.exec(url);
  if (!match) return null;
  const [, provider, path, query] = match;
  if (!isProvider(provider!) || path!.includes('//') || path!.includes('/.')) return null;
  const operation = FIXED[provider][path!];
  // Anthropic's own client sends its beta API as `?beta=true` (pi's does, #1441): the same Messages API, sent on without the query; the
  // `anthropic-beta` values that go with it are filtered as any request's.
  const beta = provider === 'anthropic' && query === 'beta=true';
  if (operation) return query === undefined || beta ? { provider, operation, path: path!, model: null, stream: null } : null;
  const native = provider === 'gemini' ? GEMINI_NATIVE.exec(path!) : null;
  if (!native) return null;
  const stream = native[2] === 'streamGenerateContent';
  // A stream is read as server-sent events only; a whole answer has no query.
  if (stream ? query !== 'alt=sse' : query !== undefined) return null;
  return { provider, operation: 'gemini_generate', path: stream ? `${path!}?alt=sse` : path!, model: native[1]!, stream };
}

/** The request headers a token may come in: whichever one the provider's own client puts its key in. */
export const MODEL_GATEWAY_TOKEN_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'] as const;

/**
 * The token a request carries: null when it has none, `invalid` when one is malformed or two headers carry different values.
 * `Authorization` must be `Bearer <token>`.
 */
export function modelGatewayToken(headers: Readonly<Record<string, string | string[] | undefined>>): string | null | 'invalid' {
  let found: string | null = null;
  for (const name of MODEL_GATEWAY_TOKEN_HEADERS) {
    const raw = headers[name];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return 'invalid';
    const value = name === 'authorization' ? (/^Bearer ([^\s]+)$/i.exec(raw)?.[1] ?? '') : raw;
    if (!MODEL_GATEWAY_TOKEN.test(value) || (found !== null && found !== value)) return 'invalid';
    found = value;
  }
  return found;
}

/** What the egress passes on to the worker, and back. The worker checks each value again. */
export const MODEL_GATEWAY_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', ...MODEL_GATEWAY_TOKEN_HEADERS] as const;
export const MODEL_GATEWAY_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-should-retry', 'request-id', 'x-request-id'] as const;

export type ModelGatewayErrorCode = 'flux_token_invalid' | 'flux_budget_exhausted' | 'flux_run_ended' | 'flux_run_busy' | 'flux_request_refused'
  | 'flux_not_found' | 'flux_request_too_large' | 'flux_method_not_allowed' | 'flux_provider_unreachable';

/**
 * A refusal of the gateway as a harness reads it: a JSON error shaped like both vendors' (`type` for Anthropic's clients, `code`
 * and `message` for OpenAI's and Google's), with `x-should-retry: false`, which the Anthropic and OpenAI clients obey.
 */
export function modelGatewayError(status: number, code: ModelGatewayErrorCode, message: string): { status: number; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({ type: 'error', error: { type: code, code, message } });
  return { status, body, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-should-retry': 'false', 'content-length': String(Buffer.byteLength(body)) } };
}
