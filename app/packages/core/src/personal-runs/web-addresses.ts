import { domainToUnicode } from 'node:url';

// Web addresses in a run (#918, #953, #954, #1065, F-036 AG-8, C-30). Since the founder's direction of 2026-11-09 an agent may open ANY
// public address. An address is still a way to send something to a site (`http://site/collect?d=<what the agent knows>`), so the server
// refuses one that carries private Flux text the run read (`privateFragmentIn`): written into it as it was, percent-encoded, in other case
// or accents, with invisible characters, spelled in hidden characters, or as a run of hex, base64 or base32. A link written in that text
// opens, and a redirect hop is refused only for what is new in it (#1136). The brief tells the agent never to put anything from Flux into an
// address; this check stops the copy. What the agent rewrote (other words, hyphens for spaces, pieces under 12 characters), or signals by
// which address it chooses, can still leave; the founder accepted that (decisions.md, "The risk, recorded").
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
/**
 * Percent-decoding passes. Private text is decoded a few times, so a hostile message cannot make keeping it slow. An address is decoded until
 * it stops changing: each pass that changes it shortens it, so an address of at most `ADDRESS_MAX` characters stops within that many passes.
 */
const TEXT_DECODE_PASSES = 4;
/** A link inside a link's query (Google's `/url?q=`, Outlook's safe links, `l.php?u=`) is a link written in the text too, this deep. */
const WRAPPED_DEPTH = 2;

/** Runs of percent-encoded bytes, decoded as UTF-8 (a broken sequence becomes U+FFFD, never an error). */
const decodedOnce = (text: string) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));

/** The text, then each percent-decoding of it, at most `passes` of them, until it stops changing. */
function percentLayers(text: string, passes: number): string[] {
  const layers = [text];
  for (let pass = 0; pass < passes; pass++) {
    const last = layers[layers.length - 1]!;
    const decoded = decodedOnce(last);
    if (decoded === last) break;
    layers.push(decoded);
  }
  return layers;
}

/** A part of an address as the check reads it: as written, decoded as often as private text is, and decoded until it stops changing. */
function addressLayers(text: string): string[] {
  const layers = percentLayers(text, TEXT_DECODE_PASSES);
  let last = layers[layers.length - 1]!;
  for (let pass = 0; pass < ADDRESS_MAX; pass++) {
    const decoded = decodedOnce(last);
    if (decoded === last) break;
    last = decoded;
  }
  return last === layers[layers.length - 1] ? layers : [...layers, last];
}

/** Characters a site can drop without a trace: format characters (zero-width spaces, joiners, soft hyphens) and control characters but space. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\p{Cf}\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;

/** Lower case, without accents and invisible characters, compatibility forms folded (NFKD), `+` as a space, each run of space as one. */
function folded(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE, '').replace(/\+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Characters that spell a text no one sees (#1136): tag characters (ASCII at U+E0020–E007E) and runs of variation selectors (a byte
 * each). They are read as what they spell, never dropped: a link with a hidden text after it is not that link.
 */
const HIDDEN = /[\u{E0020}-\u{E007E}]|(?:[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}])+/gu;
const revealed = (text: string) => text.replace(HIDDEN, (run) => {
  const first = run.codePointAt(0)!;
  if (first >= 0xe0020 && first <= 0xe007e) return String.fromCharCode(first - 0xe0000);
  return Buffer.from([...run].map((char) => { const point = char.codePointAt(0)!; return point <= 0xfe0f ? point - 0xfe00 : point - 0xe0100 + 16; })).toString('utf8');
});

/**
 * Text as an address and private Flux text are compared (#1065): percent-decoded, hidden text revealed, then lower case, without accents
 * or invisible characters, compatibility forms folded, `+` as a space and each run of space characters as one space.
 */
export function comparableText(text: string): string {
  return folded(revealed(percentLayers(text, TEXT_DECODE_PASSES).at(-1)!));
}

/**
 * A site named without a scheme (`wiki.example/lamp`, `news.example`): labels, a top level in lower-case letters, not inside an email
 * address, a longer name or an address with a scheme; then its path, if any.
 */
const BARE_SITE = /(?<![\p{L}\p{N}@._/-])(?:[\p{L}\p{N}-]+\.)+\p{Ll}{2,63}(?![\p{L}\p{N}@-]|\.[\p{L}\p{N}])(?:[/:?#][^\s<>"'`\\^{}|]*)?/gu;

/** Where a compared address starts: after its scheme and a leading `www.` (`news.example/2026/lamps`). */
const withoutScheme = (compared: string) => compared.replace(/^https?:\/\/(?:www\.)?/, '');

/**
 * Where kept text was cut: a link left out of the words, a date or a time. No window of an address can span it: a compared address
 * never holds a line break (`folded` makes every space one space).
 */
const CUT = '\n';
/** The cut in the text as written, before it is compared: a private-use character that folding keeps. */
const CUT_MARK = '';
/**
 * Dates and times (C-30, #1136): an ISO date or timestamp (`2026-11-09`, `2026-11-09t08:15:00.000z`, the brief's `2026-11-09 08:15`), a date
 * written with slashes or dots either way round (`2026/11/09`, `09.11.2026`) and a time (`08:15`, `08:15:30`). They are not private: a
 * tool's `createdAt` and today's date are in every run, and "what changed since this morning" is ordinary work. Read in compared text.
 */
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:z|[+-]\d{2}(?::?\d{2})?)?`;
const DATE_TIME = new RegExp(String.raw`(?<!\d)(?:(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})(?:[t ]${TIME})?|${TIME})(?!\d)`, 'g');
const withoutDates = (compared: string) => compared.replace(DATE_TIME, CUT);

/** A web address as the check compares it: comparable, without its scheme, `www.`, fragment, dates and times. */
const comparedAddress = (address: string) => withoutDates(withoutScheme(comparableText(address)));

/** The links inside a link's query: a redirect wrapper's target (`google.com/url?q=https://…`). */
function wrappedTargets(address: string): string[] {
  const targets: string[] = [];
  for (const value of new URL(address).searchParams.values()) {
    const target = /^https?:\/\//i.test(value) ? normalizedAddress(value) : null;
    if (target && targets.length < 4) targets.push(target);
  }
  return targets;
}

/**
 * Private Flux text as a run keeps it for the check (#1065, #1136, C-30): `body`, its words, compared, with each link, date and time cut
 * out; `addresses`, the links written in it, compared (and a wrapper's target as a link too).
 */
export interface KeptPrivateText { body: string; addresses: string[] }

/**
 * Keeps private Flux text a run read for the check (#1065, #1136): its words, compared, with the web addresses written in it cut out
 * (an address with a scheme, or a site named without one, such as `wiki.example/lamp`; never the words around it, since a tool's JSON
 * has no spaces between its fields; an email address is not an address) and its dates and times cut out; and those addresses, compared,
 * with the target inside a redirect wrapper's query. Linear in the text.
 */
export function keptPrivateText(text: string): KeptPrivateText {
  const links = new Set<string>();
  const keep = (address: string, depth: number) => {
    links.add(comparedAddress(address));
    if (depth < WRAPPED_DEPTH) for (const target of wrappedTargets(address)) keep(target, depth + 1);
  };
  const leaveOut = (raw: string, scheme: string) => {
    const kept = withoutTrailingMarks(raw);
    const address = normalizedAddress(`${scheme}${kept}`);
    if (!address) return raw;
    keep(address, 0);
    return `${CUT_MARK}${raw.slice(kept.length)}`;
  };
  const words = text.replace(ADDRESS, (raw) => leaveOut(raw, '')).replace(BARE_SITE, (raw) => leaveOut(raw, 'https://'));
  return { body: withoutDates(comparableText(words)).replaceAll(CUT_MARK, CUT), addresses: [...links] };
}

/** What a run's check reads, built once for one read from all the text the run kept: its words and its links, each once. */
export interface PrivateTextIndex { words: readonly string[]; links: readonly string[]; linkSet: ReadonlySet<string> }

export function privateTextIndex(texts: readonly KeptPrivateText[]): PrivateTextIndex {
  const words = new Set<string>();
  const links = new Set<string>();
  for (const kept of texts) {
    if (kept.body.trim()) words.add(kept.body);
    for (const address of kept.addresses) links.add(address);
  }
  return { words: [...words], links: [...links], linkSet: links };
}

/**
 * The windows the addresses of one read carried, the address asked for and each redirect hop after it (#1136): a hop may carry again
 * whatever an address before it carried, so DOI → publisher, twitter.com → x.com and a GitHub permalink → raw.githubusercontent.com open.
 */
export type AddressChain = Set<string>;
export const addressChain = (): AddressChain => new Set<string>();

/** The host (and port) a compared address without its scheme begins with. */
const siteOf = (address: string) => /^[^/?#\s]*/.exec(address)![0];

/** A window lies in the host and path of a plain reading of the address; or anywhere else (its query, a decoded run). */
const IN_PATH = 1;
const ELSEWHERE = 2;

const ALNUM = /[\p{L}\p{N}]/u;
const MARK = /[\s\p{N}@]/u;
/**
 * The fragment-like windows of `text` (#1065): 12 characters with at least 6 letters or digits and a space, a digit or an `@`. One long
 * word alone ("documentation", a name) is too common to tell what a run read from what everybody writes. Linear in the text.
 */
function addWindows(text: string, pathEnd: number, into: Map<string, number>) {
  const n = text.length;
  if (n < PRIVATE_FRAGMENT_CHARS) return;
  const letters = new Uint8Array(n);
  const marks = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const char = text[i]!;
    letters[i] = ALNUM.test(char) ? 1 : 0;
    marks[i] = MARK.test(char) ? 1 : 0;
  }
  let letterCount = 0;
  let markCount = 0;
  for (let i = 0; i < n; i++) {
    letterCount += letters[i]!;
    markCount += marks[i]!;
    const at = i - PRIVATE_FRAGMENT_CHARS + 1;
    if (at < 0) continue;
    if (letterCount >= FRAGMENT_LETTERS && markCount > 0) {
      const window = text.slice(at, at + PRIVATE_FRAGMENT_CHARS);
      into.set(window, (into.get(window) ?? 0) | (i < pathEnd ? IN_PATH : ELSEWHERE));
    }
    letterCount -= letters[at]!;
    markCount -= marks[at]!;
  }
}

/** Hex, base64 (either alphabet) and base32 runs long enough to hold a fragment, decoded at each alignment, then percent-decoded. */
function decodedRuns(text: string): string[] {
  const out: string[] = [];
  const add = (bytes: Buffer) => out.push(percentLayers(bytes.toString('utf8'), TEXT_DECODE_PASSES).at(-1)!);
  for (const [run] of text.matchAll(/[A-Za-z0-9+/_-]{16,}/g)) for (let at = 0; at < 4; at++) add(Buffer.from(run.slice(at), 'base64'));
  for (const [run] of text.matchAll(/[0-9a-f]{24,}/gi)) for (let at = 0; at < 2; at++) add(Buffer.from(run.slice(at, at + ((run.length - at) & ~1)), 'hex'));
  for (const [run] of text.matchAll(/[a-z2-7]{20,}/gi)) for (let at = 0; at < 8; at++) add(base32(run.slice(at)));
  return out;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** RFC 4648 base32, without padding, either case. */
function base32(text: string): Buffer {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text.toLowerCase()) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xfff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  return Buffer.from(bytes);
}

/**
 * Every way the address can carry text to a site (#1065), as windows: its host and path, then its query, as the server sends it (the URL
 * parser drops tabs and line breaks and encodes the host) and with its host in Unicode, each percent-decoded as often as it was encoded and
 * with any hidden text revealed;
 * and the hex, base64 and base32 runs of the decoded address, decoded. The fragment (`#…`) is never sent and is not read. Null when it is no
 * web address (nothing is sent). Bounded by the address's length (`ADDRESS_MAX`), never by what the run read.
 */
function readingsOf(address: string): { windows: Map<string, number>; compared: string } | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const hosts = new Set([url.host]);
  const unicode = domainToUnicode(url.hostname);
  if (unicode && unicode !== url.hostname) hosts.add(url.port ? `${unicode}:${url.port}` : unicode);
  const paths = addressLayers(url.pathname).map(revealed);
  const queries = addressLayers(url.search).map(revealed);
  const windows = new Map<string, number>();
  for (const host of hosts) {
    for (let layer = 0; layer < Math.max(paths.length, queries.length); layer++) {
      const hostPath = folded(`${host}${paths[Math.min(layer, paths.length - 1)]!}`).replace(/^www\./, '');
      addWindows(`${hostPath}${folded(queries[Math.min(layer, queries.length - 1)]!)}`, hostPath.length, windows);
    }
  }
  for (const run of [...decodedRuns(`${url.host}${paths.at(-1)!}`), ...decodedRuns(queries.at(-1)!)]) addWindows(folded(run), 0, windows);
  return { windows, compared: comparedAddress(url.href) };
}

/**
 * The longest link written in the private text that the address begins with, followed by nothing, a path or a query (`doc/edit` →
 * `doc/edit?usp=sharing`). A few `Set` lookups, one at each mark of the address.
 */
function writtenPrefix(compared: string, links: ReadonlySet<string>): string | null {
  if (links.has(compared)) return compared;
  for (let end = compared.length - 1; end > 0; end--) {
    if (!'/?&;=#'.includes(compared[end]!)) continue;
    if (links.has(compared.slice(0, end + 1))) return compared.slice(0, end + 1);
    if (links.has(compared.slice(0, end))) return compared.slice(0, end);
  }
  return null;
}

// A rolling hash of 12-character windows (Rabin-Karp): one pass over the run's kept text finds which of the address's windows stand in it,
// whatever the number of links or texts. The multiplier is random for each process, so text cannot be made to collide with an address.
const W = PRIVATE_FRAGMENT_CHARS;
const BASE = (Math.floor(Math.random() * 0x3fffffff) * 2 + 1) | 0;
const BASE_POW = Array.from({ length: W - 1 }).reduce<number>((power) => Math.imul(power, BASE), 1);
const hashOf = (text: string, at: number) => { let hash = 0; for (let i = 0; i < W; i++) hash = (Math.imul(hash, BASE) + text.charCodeAt(at + i)) | 0; return hash; };
/** How much kept text is read between two yields to the event loop: about a millisecond's work. */
const SCAN_SLICE = 1 << 18;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Candidate { window: string; where: number; sameSite: boolean }

/** The address's windows that are not allowed, looked up by hash, with a bitmap in front of the map. */
class Candidates {
  private readonly table = new Map<number, Candidate[]>();
  private readonly bits: Uint32Array;
  private readonly shift: number;
  constructor(windows: Iterable<[string, number]>, count: number) {
    const size = Math.min(24, Math.max(12, Math.ceil(Math.log2(count * 32))));
    this.bits = new Uint32Array((1 << size) >>> 5);
    this.shift = 32 - size;
    for (const [window, where] of windows) {
      const hash = hashOf(window, 0);
      const list = this.table.get(hash);
      if (list) list.push({ window, where, sameSite: false }); else this.table.set(hash, [{ window, where, sameSite: false }]);
      const slot = hash >>> this.shift;
      this.bits[slot >>> 5]! |= 1 << (slot & 31);
    }
  }
  /** Each candidate that stands in `text` at a window starting in [from, to): `hit` returns the refused window, or null to go on. */
  scan(text: string, from: number, to: number, hit: (candidate: Candidate) => string | null): string | null {
    if (from >= to) return null;
    const { bits, table, shift } = this;
    let hash = hashOf(text, from);
    for (let at = from; ; at++) {
      const slot = hash >>> shift;
      if (bits[slot >>> 5]! & (1 << (slot & 31))) {
        for (const candidate of table.get(hash) ?? []) {
          if (text.startsWith(candidate.window, at)) { const refused = hit(candidate); if (refused) return refused; }
        }
      }
      if (at + 1 >= to) return null;
      hash = (Math.imul(hash - Math.imul(text.charCodeAt(at), BASE_POW), BASE) + text.charCodeAt(at + W)) | 0;
    }
  }
}

/**
 * The fragment of private Flux text the run read that `address` carries (#1065, #1136, C-30), or null: the server refuses to open it. A
 * fragment is a 12-character window of a reading of the address (with at least 6 letters or digits and a space, a digit or an `@`) that
 * stands in the run's words, or in a link written in its private text. These do not count:
 * - what the address it came from carried (`chain`: the address asked for, then each redirect hop);
 * - the text of a link written in the private text that the address is, or begins with (a page a person named, its page 2, `?raw=true`);
 * - in its host and path, the text of a link of the same site (`docs/d/<id>/edit` → `docs/d/<id>/export`); never in its query, where a
 *   form or a search on that site could collect it (`docs.google.com/forms/…/formResponse?entry.1=<id>`).
 * The work is bounded by the address's length and one pass over the kept text, which yields to the event loop as it goes. An address that
 * opens adds its windows to `chain`.
 */
export async function privateFragmentIn(address: string, index: PrivateTextIndex, chain: AddressChain = addressChain()): Promise<string | null> {
  const readings = readingsOf(address);
  if (!readings) return null;
  const opened = () => { for (const window of readings.windows.keys()) chain.add(window); return null; };
  const named = writtenPrefix(readings.compared, index.linkSet);
  if (named === readings.compared) return opened();
  const allowed = new Map<string, number>();
  if (named) addWindows(named, 0, allowed);
  const open = [...readings.windows].filter(([window]) => !chain.has(window) && !allowed.has(window));
  if (!open.length) return opened();
  const candidates = new Candidates(open, open.length);
  const site = siteOf(readings.compared);
  const sameSite = (link: string) => link.startsWith(site) && (link.length === site.length || '/?#'.includes(link[site.length]!));
  let budget = SCAN_SLICE;
  const read = async (text: string, hit: (candidate: Candidate) => string | null): Promise<string | null> => {
    for (let from = 0, last = text.length - W + 1; from < last;) {
      const to = Math.min(last, from + budget);
      const refused = candidates.scan(text, from, to, hit);
      if (refused) return refused;
      budget -= to - from;
      from = to;
      if (budget <= 0) { await yieldToLoop(); budget = SCAN_SLICE; }
    }
    return null;
  };
  // First the links of the address's own site: a window of its host and path that one of them holds is that link's own text.
  const own = (candidate: Candidate) => (candidate.where & ELSEWHERE ? candidate.window : ((candidate.sameSite = true), null));
  for (const link of index.links) if (sameSite(link)) { const refused = await read(link, own); if (refused) return refused; }
  const other = (candidate: Candidate) => (candidate.where & ELSEWHERE || !candidate.sameSite ? candidate.window : null);
  for (const link of index.links) if (!sameSite(link)) { const refused = await read(link, other); if (refused) return refused; }
  for (const words of index.words) { const refused = await read(words, other); if (refused) return refused; }
  return opened();
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
