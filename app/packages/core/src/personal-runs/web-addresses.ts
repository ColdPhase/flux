// Web addresses in a run (#918, #953, #954, #1065, F-036 AG-8, C-30). Since the founder's direction of 2026-11-09 an agent may open ANY
// public address. An address is still a way to send something to a site (`http://site/collect?d=<what the agent knows>`), so the server
// refuses one that carries private Flux text the run read, written into it as it was (`privateFragmentIn`): the brief tells the agent never
// to put anything from Flux into an address, and this check stops the plain copy. What the agent rewrote, encoded or signals by which
// address it chooses can still leave; the founder accepted that (decisions.md, "The risk, recorded").
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

/** How long a fragment of private Flux text is that an address may not carry (#1065, C-30), in compared characters. */
export const PRIVATE_FRAGMENT_CHARS = 12;
/** How many of its characters are letters or digits: punctuation and spaces alone never make a fragment. */
const FRAGMENT_LETTERS = 6;

/** Runs of percent-encoded bytes, decoded as UTF-8 (a broken sequence becomes U+FFFD, never an error). */
const decodedOnce = (text: string) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));

/**
 * Text as an address and private Flux text are compared (#1065): NFKC, percent-decoded up to three times (an address encoded twice is
 * still compared as written), `+` as a space, lower case, and each run of space characters as one space.
 */
export function comparableText(text: string): string {
  let out = text.normalize('NFKC');
  for (let pass = 0; pass < 3; pass++) {
    const decoded = decodedOnce(out);
    if (decoded === out) break;
    out = decoded;
  }
  return out.replace(/\+/g, ' ').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Private Flux text as the run keeps it for the check (#1065): comparable, without the web addresses and host names written in it (a word
 * with `://`, or with a dot between two letters or digits, such as `a.example/x`), so an address a person wrote can still be opened.
 */
export function keptPrivateText(text: string): string {
  return comparableText(text.split(/(\s+)/).map((word) => (word.includes('://') || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(word) ? ' ' : word)).join(''));
}

/**
 * Whether a window of compared text can be a fragment: 12 characters with at least 6 letters or digits, of two words or more or with a
 * digit. One long word alone ("documentation", a name) is too common to tell what a run read from what everybody writes.
 */
function fragmentLike(window: string): boolean {
  return (window.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= FRAGMENT_LETTERS && /[\s\p{N}]/u.test(window);
}

/**
 * The first fragment of private Flux text the run read (`texts`, kept by `keptPrivateText`) that `address` carries (#1065, C-30): the
 * server refuses to open it. Null when it carries none.
 */
export function privateFragmentIn(address: string, texts: readonly string[]): string | null {
  const compared = comparableText(address);
  const windows = new Set<string>();
  for (let at = 0; at + PRIVATE_FRAGMENT_CHARS <= compared.length; at++) {
    const window = compared.slice(at, at + PRIVATE_FRAGMENT_CHARS);
    if (fragmentLike(window)) windows.add(window);
  }
  if (!windows.size) return null;
  for (const text of texts) {
    for (let at = 0; at + PRIVATE_FRAGMENT_CHARS <= text.length; at++) {
      const window = text.slice(at, at + PRIVATE_FRAGMENT_CHARS);
      if (windows.has(window)) return window;
    }
  }
  return null;
}

/**
 * The most queries, results and cited addresses kept of one response of the provider's web search (#954): a sanity bound on one
 * response, not on a run. A response of many searches (#1113) is kept whole up to these; the repository writes it in as many rows as it
 * needs, and a run has as many responses as it makes requests.
 */
export const WEB_SEARCH_BOUNDS = { queries: 100, query: 300, results: 1_000, cited: 1_000 } as const;

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
