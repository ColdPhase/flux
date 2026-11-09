import { fetchPage, FETCH_LIMITS, literalRefusal, PRODUCTION_RULES, type FetchFailure, type FetchHooks, type FetchKind, type FetchResult, type FetchRules } from '../link-previews/safe-fetch.js';
import { readablePage, type ReadablePage } from './readable.js';

// An agent reads a web page (#918, F-036 AG-8): the server fetches it, never the agent's own process, with the same guard as a link
// card (`link-previews/safe-fetch.ts`: public addresses only, the scheme's default port, no credentials, at most 3 redirects each
// judged again, no cookies, no Referer, one fixed User-Agent), and only ever with GET. Nothing is posted or submitted: there is no
// way to send anything to a page from here. The page comes back as bounded plain text, labelled as data.

/** Reading a page may take longer than a card and returns more of it, but it is still bounded in time and in bytes. */
export const WEB_READ_LIMITS = { connectMs: 3_000, totalMs: 8_000, maxBytes: 512 * 1024, maxRedirects: 3 } as const;
export const WEB_READ_KIND: FetchKind = { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', types: /^(text\/html|application\/xhtml\+xml|text\/plain)\b/ };
/**
 * Pages the server reads at once: the one guard of the fetcher. There is no limit per minute (founder direction 2026-11-09, #1116): a
 * research run reads as many pages as its question needs, one after another, and what stops it is the key's budget.
 */
export const READS_AT_ONCE = 6;

export type WebReadFailure = FetchFailure | 'busy' | 'off' | 'empty' | 'private_text';
/**
 * `requested` is every address the server sent a request to for this read (#953): empty when it was refused from the address alone or for
 * the rate, otherwise the address and each redirect hop, whether or not a page came back.
 */
export type WebReadResult =
  | { ok: true; url: string; finalUrl: string; title: string | null; text: string; truncated: boolean; requested: string[] }
  | { ok: false; reason: WebReadFailure; requested: string[] };

export interface WebReaderOptions {
  enabled: boolean;
  /** The rules of the deployment (production's, or a test deployment's closed world); the limits are this module's. */
  rules?: FetchRules;
  /** TEST ONLY: where a named host connects (config `testHosts`). */
  connectTo?: (host: string) => { host: string; port: number } | null;
  /** TEST ONLY: replaces the network fetch. */
  fetch?: (address: string) => Promise<FetchResult>;
}

/** What each refusal says to the agent, in plain words: a reason, never a way around it. */
export const WEB_READ_WORDS: Record<WebReadFailure, string> = {
  blocked: 'That address cannot be read: only public web pages on the standard port can.',
  unreachable: 'The page could not be reached.',
  timeout: 'The page took too long to answer.',
  status: 'The page did not answer with a readable page.',
  type: 'That is not a web page or a text page.',
  redirects: 'The address redirects too many times.',
  invalid: 'That is not a web address.',
  busy: 'Too many pages were read just now. Carry on without it, or try again later.',
  off: 'Reading the web is not turned on for this Flux.',
  empty: 'The page has no text to read.',
  // The same on every engine (#1136): not every engine has a web search, and the brief already tells one that has it to look things up there.
  private_text: 'That address carries words you read in Flux, and nothing from Flux may go into a web address. Open the page without them.',
};

export function webReader(options: WebReaderOptions) {
  const base = options.rules ?? PRODUCTION_RULES;
  const rules: FetchRules = { ...base, limits: { ...FETCH_LIMITS, ...WEB_READ_LIMITS } };
  let running = 0;

  /** Whether the server may start one more read now. */
  const allow = () => running < READS_AT_ONCE;

  return {
    get enabled() { return options.enabled; },
    /**
     * Reads one page for an agent. Never throws, except what the caller's `beforeRequest` throws: it runs with each address just
     * before its request is sent (the first and every redirect hop) and a throw ends the read before that request.
     */
    async read(address: string, hooks: FetchHooks = {}): Promise<WebReadResult> {
      if (!options.enabled) return { ok: false, reason: 'off', requested: [] };
      // Refused from the address alone (not a web address, scheme, port, credentials, local name, IP literal): no network, so no read is spent.
      let url: URL;
      try { url = new URL(address); } catch { return { ok: false, reason: 'invalid', requested: [] }; }
      url.hash = ''; // never sent, and no part of the address that is recorded
      if (literalRefusal(url, rules)) return { ok: false, reason: 'blocked', requested: [] };
      if (!allow()) return { ok: false, reason: 'busy', requested: [] };
      running++;
      try {
        let page: FetchResult;
        if (options.fetch) {
          // TEST ONLY: a fake says nothing of hops, so the hook is run for the address asked, and then for where it ended.
          await hooks.beforeRequest?.(url.href);
          page = await options.fetch(address);
          if (page.ok && page.url !== url.href) await hooks.beforeRequest?.(page.url);
        } else page = await fetchPage(address, rules, options.connectTo, WEB_READ_KIND, hooks);
        const requested = page.requested ?? (page.ok ? [...new Set([url.href, page.url])] : [url.href]);
        if (!page.ok) return { ok: false, reason: page.reason, requested };
        const readable: ReadablePage = readablePage(page.html, !/^text\/plain\b/i.test(page.type ?? ''));
        if (!readable.text && !readable.title) return { ok: false, reason: 'empty', requested };
        return { ok: true, url: address, finalUrl: page.url, title: readable.title, text: readable.text, truncated: readable.truncated, requested };
      } finally { running--; }
    },
  };
}

export type WebReader = ReturnType<typeof webReader>;
