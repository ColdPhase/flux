// Which web addresses an agent may read (#953, F-036 AG-8, coordinator default C-30). The server fetches what an agent names, so an address
// is a way to send something to a site: `http://site/collect?d=<what the agent knows>`. An agent therefore reads only addresses it was
// GIVEN: written in the request it answers, in the task or conversation it works in, or on a page it read in the same run. It never
// composes one, so nothing it knows can be put into one; it can only choose among addresses that already stood there. The comparison is
// exact (the whole address, query included; the fragment never travels and is ignored). One run reads a bounded number of addresses.

/** The most distinct addresses one run may ask for, so the choice among given addresses carries little and the sources line stays short. */
export const WEB_READS_PER_RUN = 20;
/** The most addresses a run is given when it starts, from all the texts together. */
export const GIVEN_AT_START_MAX = 400;
/** The most addresses taken from one text, and from one page's text. */
export const ADDRESSES_PER_TEXT = 50;
/** The longest address that is read (the tool's own bound). */
export const ADDRESS_MAX = 2048;

// Linear: a run of address characters after the scheme, nothing nested.
const ADDRESS = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;
/** Marks that follow an address in a sentence without belonging to it. */
const MARKS = new Set(['.', ',', ';', ':', '!', '?', "'", '"', ']', '\u00bb', '\u201d', '\u2019']);
/** The most of a text that is looked at for addresses. */
const SCANNED = 20_000;

/** "(see http://a.example/x)" and "http://a.example/x." end where the address does; "http://a.example/wiki/Foo_(bar)" keeps its bracket. */
function withoutTrailingMarks(raw: string): string {
  let end = Math.min(raw.length, ADDRESS_MAX + 1);
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) { if (raw[i] === '(') open++; else if (raw[i] === ')') close++; }
  while (end > 0) {
    const last = raw[end - 1]!;
    if (MARKS.has(last)) end--;
    else if (last === ')' && close > open) { end--; close--; } else break;
  }
  return raw.slice(0, end);
}

/** The address as it is compared: valid, without its fragment; null when it is not a web address. */
export function normalizedAddress(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href.length <= ADDRESS_MAX ? url.href : null;
  } catch { return null; }
}

/** The web addresses written in a text, each once, normalized, in order. */
export function addressesIn(text: string, most = ADDRESSES_PER_TEXT): string[] {
  const found = new Set<string>();
  for (const match of text.slice(0, SCANNED).matchAll(ADDRESS)) {
    const address = normalizedAddress(withoutTrailingMarks(match[0]));
    if (address) found.add(address);
    if (found.size >= most) break;
  }
  return [...found];
}

/** Whether `address` stands in one of the `given` texts. */
export function isGivenAddress(address: string, given: ReadonlySet<string>): boolean {
  const normalized = normalizedAddress(address);
  return normalized !== null && given.has(normalized);
}

/** The addresses written in all of these texts. */
export function givenAddresses(texts: readonly string[]): Set<string> {
  const given = new Set<string>();
  for (const text of texts) for (const address of addressesIn(text)) given.add(address);
  return given;
}

/** The most queries, results and cited addresses kept of one response of the provider's web search (#954). */
export const WEB_SEARCH_BOUNDS = { queries: 10, query: 300, results: 100, cited: 100 } as const;

/**
 * What one response of the provider's built-in web search brought, as Flux keeps it (#954, C-30): the queries as plain one-line text
 * (control characters gone, at most 300 characters), the result and cited addresses normalized like any address (web addresses only,
 * no fragment, at most `ADDRESS_MAX` long), each once and bounded. What is not a web address is dropped, never kept.
 */
export function boundedWebSearch(found: { queries: readonly unknown[]; results: readonly unknown[]; cited: readonly unknown[] }) {
  const addresses = (values: readonly unknown[], most: number) => {
    const kept = new Set<string>();
    for (const value of values) {
      const address = typeof value === 'string' ? normalizedAddress(value) : null;
      if (address) kept.add(address);
      if (kept.size >= most) break;
    }
    return [...kept];
  };
  const queries = new Set<string>();
  for (const value of found.queries) {
    // eslint-disable-next-line no-control-regex
    const query = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WEB_SEARCH_BOUNDS.query) : '';
    if (query) queries.add(query);
    if (queries.size >= WEB_SEARCH_BOUNDS.queries) break;
  }
  return { queries: [...queries], results: addresses(found.results, WEB_SEARCH_BOUNDS.results), cited: addresses(found.cited, WEB_SEARCH_BOUNDS.cited) };
}
