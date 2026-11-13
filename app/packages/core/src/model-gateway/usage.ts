import type { AiProviderKind } from '@flux/contracts';
import type { GatewayOperation } from './admission.js';

// The usage a provider reports in one answer through the model gateway (#1441), read as the answer passes: a whole JSON answer, or
// server-sent events whose usage arrives in some of the events. Each wire format reports it its own way:
//   Anthropic Messages: `usage` (whole), or `message_start.message.usage` then `message_delta.usage` (stream; the delta's counts win);
//   Chat Completions (OpenAI, OpenRouter, Gemini's compatible endpoint, compatible servers): `usage`, in a stream the last chunk's,
//     with OpenRouter's `usage.cost` in dollars;
//   OpenAI Responses: `usage` (whole), or `response.completed` / `response.incomplete` events' `response.usage` (stream);
//   Gemini generateContent: `usageMetadata`, in a stream the last chunk's (its counts are running totals).
// Anything else — no usage, a count that is not a whole number, an error event, a stream that never finished — is no usage (null),
// and the request is charged all it held.

export interface GatewayUsage {
  /** Every input token, the cached ones included. */
  inputTokens: number;
  /** Every output token, reasoning included. */
  outputTokens: number;
  /** Anthropic's cache writes and reads, within `inputTokens` (#1410). */
  cache?: { readTokens: number; writeTokens: number };
  /** Searches of the provider's own web search (none can be asked through the gateway; any reported makes the usage out of bounds). */
  webSearches?: number;
  /** OpenRouter's reported cost of the answer, in micro-dollars. */
  reportedCostMicros?: number;
}

export interface UsageMeter {
  /** One chunk of the answer's body, as it passes. */
  push(chunk: Uint8Array): void;
  /** The answer ended normally: its usage, or null when it had none that can be used. */
  end(): GatewayUsage | null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** A count that may be left out when it is zero (Gemini leaves out what it did not use). */
const optional = (value: unknown): number | null => (value === undefined || value === null ? 0 : whole(value) ? value : null);

function anthropicUsage(usage: unknown): GatewayUsage | null {
  if (!isObject(usage)) return null;
  const input = usage.input_tokens; const output = usage.output_tokens;
  const written = optional(usage.cache_creation_input_tokens); const read = optional(usage.cache_read_input_tokens);
  const tool = usage.server_tool_use;
  const searches = isObject(tool) ? optional(tool.web_search_requests) : tool === undefined || tool === null ? 0 : null;
  if (!whole(input) || !whole(output) || written === null || read === null || searches === null) return null;
  const inputTokens = input + written + read;
  if (!Number.isSafeInteger(inputTokens)) return null;
  return { inputTokens, outputTokens: output, ...(written || read ? { cache: { readTokens: read, writeTokens: written } } : {}), ...(searches ? { webSearches: searches } : {}) };
}

function chatUsage(usage: unknown, provider: AiProviderKind): GatewayUsage | null {
  if (!isObject(usage) || !whole(usage.prompt_tokens) || !whole(usage.completion_tokens)) return null;
  const cost = usage.cost;
  const reported = provider === 'openrouter' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.ceil(cost * 1_000_000) : null;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, ...(reported !== null && Number.isSafeInteger(reported) ? { reportedCostMicros: reported } : {}) };
}

function responsesUsage(usage: unknown): GatewayUsage | null {
  if (!isObject(usage) || !whole(usage.input_tokens) || !whole(usage.output_tokens)) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function geminiUsage(usage: unknown): GatewayUsage | null {
  if (!isObject(usage) || !whole(usage.promptTokenCount)) return null;
  const candidates = optional(usage.candidatesTokenCount); const thoughts = optional(usage.thoughtsTokenCount);
  const toolPrompt = optional(usage.toolUsePromptTokenCount);
  if (candidates === null || thoughts === null || toolPrompt === null) return null;
  const inputTokens = usage.promptTokenCount + toolPrompt; const outputTokens = candidates + thoughts;
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) ? { inputTokens, outputTokens } : null;
}

/** The usage of a whole (not streamed) answer. */
export function wholeAnswerUsage(operation: GatewayOperation, provider: AiProviderKind, answer: unknown): GatewayUsage | null {
  if (!isObject(answer)) return null;
  switch (operation) {
    case 'anthropic_messages': return answer.type === 'error' ? null : anthropicUsage(answer.usage);
    case 'openai_chat': return chatUsage(answer.usage, provider);
    case 'openai_responses': return answer.status === 'failed' ? null : responsesUsage(answer.usage);
    case 'gemini_generate': return geminiUsage(answer.usageMetadata);
  }
}

/** Reads one stream's events; `event` sees every `data:` value that is JSON, and `result` gives the usage at the end. */
interface StreamReader { event(data: Json): void; result(): GatewayUsage | null }

function anthropicStream(): StreamReader {
  let start: Json | null = null; let delta: Json | null = null; let failed = false; let stopped = false;
  return {
    event(data) {
      if (data.type === 'message_start' && isObject(data.message) && isObject(data.message.usage)) start = { ...data.message.usage };
      else if (data.type === 'message_delta' && isObject(data.usage)) delta = { ...(delta ?? {}), ...data.usage };
      else if (data.type === 'message_stop') stopped = true;
      else if (data.type === 'error') failed = true;
    },
    // The delta's counts are the final ones; the start's input and cache counts stand where the delta leaves them out.
    result: () => (failed || !stopped || !start || !delta ? null : anthropicUsage({ ...start, ...delta })),
  };
}

function chatStream(provider: AiProviderKind): StreamReader {
  let usage: unknown = null; let failed = false;
  return {
    event(data) {
      if (isObject(data.usage)) usage = data.usage;
      if (data.error !== undefined) failed = true;
    },
    result: () => (failed ? null : chatUsage(usage, provider)),
  };
}

function responsesStream(): StreamReader {
  let usage: unknown = null; let failed = false;
  return {
    event(data) {
      if ((data.type === 'response.completed' || data.type === 'response.incomplete') && isObject(data.response)) usage = data.response.usage;
      if (data.type === 'response.failed' || data.type === 'error') failed = true;
    },
    result: () => (failed ? null : responsesUsage(usage)),
  };
}

function geminiStream(): StreamReader {
  let usage: unknown = null; let failed = false;
  return {
    event(data) {
      if (data.usageMetadata !== undefined) usage = data.usageMetadata;
      if (data.error !== undefined) failed = true;
    },
    result: () => (failed ? null : geminiUsage(usage)),
  };
}

/** The longest event line kept while it arrives: a line past it makes the usage unknown (its answer still passes). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * A meter for one answer: `stream` answers are read as server-sent events line by line, keeping only the current line; a whole answer
 * is kept up to `maxWholeBytes` and parsed at its end. Lines are decoded as UTF-8 once whole, so a character split across chunks is read
 * right. Only events that can carry usage, an error or an end are parsed.
 */
export function usageMeter(operation: GatewayOperation, provider: AiProviderKind, stream: boolean, maxWholeBytes: number): UsageMeter {
  if (!stream) {
    const chunks: Buffer[] = []; let size = 0; let over = false;
    return {
      push(chunk) {
        if (over) return;
        size += chunk.byteLength;
        if (size > maxWholeBytes) { over = true; chunks.length = 0; return; }
        chunks.push(Buffer.from(chunk));
      },
      end() {
        if (over) return null;
        try { return wholeAnswerUsage(operation, provider, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return null; }
      },
    };
  }
  const reader = operation === 'anthropic_messages' ? anthropicStream() : operation === 'openai_responses' ? responsesStream()
    : operation === 'gemini_generate' ? geminiStream() : chatStream(provider);
  let line: Buffer[] = []; let lineSize = 0; let broken = false;
  const take = (bytes: Buffer) => {
    const text = bytes.toString('utf8').replace(/\r$/, '');
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trimStart();
    // A delta of text or of a tool's arguments is skipped unread; only these can say something about usage or the end.
    if (!/"(usage|usageMetadata|message_start|message_delta|message_stop|error|response\.(completed|incomplete|failed))"/.test(data)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (isObject(parsed)) reader.event(parsed);
  };
  return {
    push(chunk) {
      if (broken) return;
      let bytes = Buffer.from(chunk);
      for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a)) {
        line.push(bytes.subarray(0, at));
        take(Buffer.concat(line));
        line = []; lineSize = 0;
        bytes = bytes.subarray(at + 1);
      }
      if (bytes.byteLength) {
        lineSize += bytes.byteLength;
        if (lineSize > MAX_LINE_BYTES) { broken = true; line = []; return; }
        line.push(bytes);
      }
    },
    end() {
      if (broken) return null;
      if (line.length) take(Buffer.concat(line));
      return reader.result();
    },
  };
}
