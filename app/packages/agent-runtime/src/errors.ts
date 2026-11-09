/** A 2xx answer that is not a usable response of its wire format (no usable usage, a broken tool call). */
export class MalformedResponseError extends Error {
  constructor(what: string) {
    super(`The provider response was malformed: ${what}`);
    this.name = 'MalformedResponseError';
  }
}

/** The provider refused its own web search tool on this request (#954); nothing was done, so nothing was billed. */
export class SearchRefusedError extends Error {
  constructor() {
    super('The provider refused its web search tool');
    this.name = 'SearchRefusedError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Anthropic's refusal of its web search tool (#954; the review of #1073): a 400 `invalid_request_error` whose message says web search is
 * not enabled, which is what an organization whose admin turned it off in the Console gets (platform.claude.com web search tool page, read
 * 2026-11-09). Only the error's own `type` and `message` are read, never anything else of the body, and the message must begin with
 * the refusal (a message about something else that quotes these words is not one); any other 400 is a provider error.
 */
export function anthropicSearchRefusal(body: unknown): boolean {
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  return error?.type === 'invalid_request_error' && typeof error.message === 'string'
    && /^\s*web search (?:is not enabled|is disabled|has been disabled)\b/i.test(error.message);
}

/**
 * OpenAI's refusal of its web search tool for a model that has none (#954): a 400 `invalid_request_error` whose message says the tool
 * `web_search` (or the older `web_search_preview`) is not supported. Read only from the JSON error's `type` and `message`, which must
 * begin with the refusal.
 */
export function openAiSearchRefusal(text: string): boolean {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return false; }
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  return error?.type === 'invalid_request_error' && typeof error.message === 'string'
    && /^\s*(?:hosted\s+)?tool\s+['"`]?web_search(?:_preview)?['"`]?\s+is not supported/i.test(error.message);
}
