import type { LinkPreviewCard } from '@flux/contracts';
import { parsePagePreview, type PagePreview } from './html.js';
import { fetchPage, literalRefusal, PRODUCTION_RULES, type FetchResult, type FetchRules } from './safe-fetch.js';

/** How long a fetched page is believed, and how long a failed or empty one is not asked again. */
export const CACHE_TTL = { foundMs: 6 * 60 * 60_000, missMs: 15 * 60_000 } as const;
export const CACHE_ENTRIES = 1_000;
/** Page fetches one person may start per minute (cache hits cost nothing), and fetches the server runs at once. */
export const FETCHES_PER_MINUTE = 20;
export const FETCHES_AT_ONCE = 8;

type Entry = { at: number; preview: PagePreview | null };

export interface LinkPreviewOptions {
  rules?: FetchRules;
  /** TEST ONLY: where a named host connects (config `testHosts`). */
  connectTo?: (host: string) => { host: string; port: number } | null;
  now?: () => number;
  fetch?: (address: string) => Promise<FetchResult>;
}

/**
 * Cards for web addresses (#469). The cache holds only what a page says about itself (a title and a description of at most 300
 * characters), keyed by address, in this process's memory: nothing is written to the database or to disk, and a restart empties
 * it. A page's text is public to whoever can fetch it; who may be given it is decided by the caller, which asks only for addresses
 * of messages the reader can read.
 */
export function linkPreviews(options: LinkPreviewOptions = {}) {
  const rules = options.rules ?? PRODUCTION_RULES;
  const now = options.now ?? Date.now;
  const fetchOne = options.fetch ?? ((address: string) => fetchPage(address, rules, options.connectTo));
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<PagePreview | null>>();
  const started = new Map<string, number[]>();
  let running = 0;

  const keyOf = (address: string) => { const url = new URL(address); url.hash = ''; return url.href; };
  const fresh = (entry: Entry) => now() - entry.at < (entry.preview ? CACHE_TTL.foundMs : CACHE_TTL.missMs);

  /** Whether this person may start one more fetch now; records it when so. */
  function allow(userId: string): boolean {
    if (running >= FETCHES_AT_ONCE) return false;
    const since = now() - 60_000;
    const recent = (started.get(userId) ?? []).filter((at) => at > since);
    if (recent.length >= FETCHES_PER_MINUTE) { started.set(userId, recent); return false; }
    started.set(userId, [...recent, now()]);
    if (started.size > 10_000) for (const [id, times] of started) if (times.every((at) => at <= since)) started.delete(id);
    return true;
  }

  function remember(key: string, preview: PagePreview | null) {
    cache.delete(key);
    cache.set(key, { at: now(), preview });
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }

  async function load(key: string): Promise<PagePreview | null> {
    running++;
    try {
      const page = await fetchOne(key);
      const preview = page.ok ? parsePagePreview(page.html) : null;
      const found = preview && (preview.title || preview.description) ? preview : null;
      remember(key, found);
      return found;
    } finally { running--; }
  }

  return {
    /** The cards for these addresses (already limited by the caller); `busy` when some were skipped for the person's rate. */
    async cards(userId: string, addresses: readonly string[]): Promise<{ busy: boolean; cards: LinkPreviewCard[] }> {
      let busy = false;
      const cards = await Promise.all(addresses.map(async (address): Promise<LinkPreviewCard | null> => {
        let key: string;
        try {
          key = keyOf(address);
          // Refused from the address alone (scheme, port, credentials, local name, IP literal): no network, so no rate is spent.
          if (literalRefusal(new URL(address), rules)) return null;
        } catch { return null; }
        const hit = cache.get(key);
        let preview: PagePreview | null;
        if (hit && fresh(hit)) preview = hit.preview;
        else {
          let pending = inflight.get(key);
          if (!pending) {
            if (!allow(userId)) { busy = true; return null; }
            pending = load(key).finally(() => inflight.delete(key));
            inflight.set(key, pending);
          }
          preview = await pending;
        }
        return preview ? { url: address, title: preview.title, description: preview.description } : null;
      }));
      return { busy, cards: cards.filter((card): card is LinkPreviewCard => card !== null) };
    },
  };
}

export type LinkPreviews = ReturnType<typeof linkPreviews>;
