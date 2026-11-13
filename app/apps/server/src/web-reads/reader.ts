import { fetchPage, FETCH_LIMITS, literalRefusal, PRODUCTION_RULES, type FetchFailure, type FetchHooks, type FetchKind, type FetchResult, type FetchRules } from '../link-previews/safe-fetch.js';
import { cleanPicture, PICTURE_LIMITS, ServiceUnavailableError, type CleanPicture, type PictureCanonicalizer, type PictureRefusal } from '@flux/core';
import type { ThoughtImageType } from '@flux/contracts';
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

export type WebReadFailure = FetchFailure | 'busy' | 'off' | 'empty' | 'private_text' | 'too_long';

/**
 * A picture an agent attaches to its answer (#1217, AG-8, C-59): the same guard and the same switch as a page read, a little longer to
 * arrive, and a body of at most a stored file's 5 MiB, read whole or refused. What is kept is only the picture (`cleanPicture`).
 */
export const PICTURE_FETCH_LIMITS = { connectMs: 3_000, totalMs: 10_000, maxBytes: PICTURE_LIMITS.bytes, maxRedirects: 3 } as const;
export const PICTURE_KIND: FetchKind = { accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1',
  // Any image/ type and an untyped body pass on to the bytes, which alone decide (an SVG is then refused as one, in its own words).
  types: /^(image\/|application\/octet-stream\b|binary\/octet-stream\b)/, binary: true };
export type PictureFailure = Exclude<WebReadFailure, 'empty'> | PictureRefusal;
export type PictureResult =
  | { ok: true; url: string; finalUrl: string; type: ThoughtImageType; bytes: Uint8Array; width: number; height: number; requested: string[] }
  | { ok: false; reason: PictureFailure; requested: string[] };

/** What each refusal of a picture says to the agent, in plain words, which it passes on to its owner. */
export const PICTURE_WORDS: Record<PictureFailure, string> = {
  blocked: 'That address cannot be fetched: only pictures at public web addresses on the standard port can.',
  unreachable: 'The picture could not be reached.',
  timeout: 'The picture took too long to download.',
  status: 'The site did not answer with the picture.',
  type: 'That address is not a picture: only PNG, JPEG, WebP and GIF pictures can be attached.',
  redirects: 'The address redirects too many times.',
  invalid: 'That is not a web address.',
  too_large: 'That picture is larger than 5 MB, the most a picture may be.',
  busy: 'Too many pictures and pages are being fetched just now. Try again in a moment.',
  off: 'Fetching from the web is not turned on for this Flux, so no picture can be attached.',
  private_text: 'That address carries words you read in Flux, and nothing from Flux may go into a web address. Fetch the picture without them.',
  too_long: 'That address, or one it redirects to, is longer than a web address may be (2,048 characters as sent).',
  not_picture: 'That address is not a picture: only PNG, JPEG, WebP and GIF pictures can be attached.',
  svg: 'That is an SVG drawing, which cannot be attached: only PNG, JPEG, WebP and GIF pictures can.',
  too_many_pixels: 'That picture is too big to show: at most 8,000 pixels on a side and 40 million pixels in all.',
  broken: 'That picture is damaged and cannot be read.',
};
/**
 * `requested` is every address the server sent a request to for this read (#953): empty when it was refused from the address alone or for
 * the rate, otherwise the address and each redirect hop, whether or not a page came back.
 */
export type WebReadResult =
  | { ok: true; url: string; finalUrl: string; title: string | null; text: string; truncated: boolean; requested: string[] }
  | { ok: false; reason: WebReadFailure; requested: string[] };

export interface WebReaderOptions {
  enabled: boolean;
  /** The real decoder a picture goes through before it is kept (#1343). Without one the bytes are only walked (`cleanPicture`). */
  pictures?: PictureCanonicalizer;
  /** The rules of the deployment (production's, or a test deployment's closed world); the limits are this module's. */
  rules?: FetchRules;
  /** TEST ONLY: where a named host connects (config `testHosts`). */
  connectTo?: (host: string) => { host: string; port: number } | null;
  /** TEST ONLY: replaces the network fetch. */
  fetch?: (address: string) => Promise<FetchResult>;
  /** TEST ONLY: replaces the network fetch of a picture. */
  fetchPicture?: (address: string) => Promise<FetchResult>;
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
  // #1136: as it is sent, an address (or a redirect hop) of more than 2,048 characters is not read.
  too_long: 'That address, or one it redirects to, is longer than a web address may be (2,048 characters as sent).',
  too_large: 'The page is larger than can be read.',
};

export function webReader(options: WebReaderOptions) {
  const base = options.rules ?? PRODUCTION_RULES;
  const rules: FetchRules = { ...base, limits: { ...FETCH_LIMITS, ...WEB_READ_LIMITS } };
  const pictureRules: FetchRules = { ...base, limits: { ...FETCH_LIMITS, ...PICTURE_FETCH_LIMITS } };
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
    /**
     * Downloads one picture for an agent (#1217) under the same guard and switch, with the same `beforeRequest` before each request. The
     * bytes come back only when they are a picture, rebuilt without metadata or anything after its end. Never throws but what the hook throws.
     */
    async picture(address: string, hooks: FetchHooks = {}): Promise<PictureResult> {
      if (!options.enabled) return { ok: false, reason: 'off', requested: [] };
      let url: URL;
      try { url = new URL(address); } catch { return { ok: false, reason: 'invalid', requested: [] }; }
      url.hash = '';
      if (literalRefusal(url, pictureRules)) return { ok: false, reason: 'blocked', requested: [] };
      if (!allow()) return { ok: false, reason: 'busy', requested: [] };
      running++;
      try {
        let fetched: FetchResult;
        if (options.fetchPicture) {
          await hooks.beforeRequest?.(url.href);
          fetched = await options.fetchPicture(address);
        } else fetched = await fetchPage(address, pictureRules, options.connectTo, PICTURE_KIND, hooks);
        const requested = fetched.requested ?? [url.href];
        if (!fetched.ok) return { ok: false, reason: fetched.reason, requested };
        let picture: CleanPicture;
        try { picture = options.pictures ? await options.pictures.canonical(fetched.bytes ?? new Uint8Array()) : cleanPicture(fetched.bytes ?? new Uint8Array()); }
        catch (error) { if (error instanceof ServiceUnavailableError) return { ok: false, reason: 'busy', requested }; throw error; }
        if (!picture.ok) return { ok: false, reason: picture.reason, requested };
        return { ok: true, url: address, finalUrl: fetched.url, type: picture.type, bytes: picture.bytes, width: picture.width, height: picture.height, requested };
      } finally { running--; }
    },
  };
}

export type WebReader = ReturnType<typeof webReader>;
