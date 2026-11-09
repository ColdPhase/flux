import { domainToUnicode } from 'node:url';

// Web addresses in a run (#918, #953, #954, #1065, F-036 AG-8, C-30). Since the founder's direction of 2026-11-09 an agent may open ANY
// public address. An address is still a way to send something to a site (`http://site/collect?d=<what the agent knows>`), so the server
// refuses one that carries private Flux text the run read (`privateFragmentIn`): written into it as it was, percent-encoded, in other case
// or accents, with invisible characters, or as a run of hex, base64 or base32. The brief tells the agent never to put anything from Flux
// into an address; this check stops the copy. What the agent rewrote (other words, hyphens for spaces, pieces under 12 characters), or
// signals by which address it chooses, can still leave; the founder accepted that (decisions.md, "The risk, recorded").
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
/** The most addresses kept of one private text, as written in it: one carried to another site is refused. */
const WRITTEN_ADDRESSES = 500;

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

/** An address's layers as the check reads them: as written, decoded as often as private text is, and decoded until it stops changing. */
function addressLayers(text: string): string[] {
  const layers = percentLayers(text, TEXT_DECODE_PASSES);
  let last = layers[layers.length - 1]!;
  for (let pass = 0; pass < ADDRESS_MAX; pass++) {
    const decoded = decodedOnce(last);
    if (decoded === last) break;
    last = decoded;
  }
  return [...new Set([...layers, last])];
}

/** Characters a site can drop without a trace: format characters (zero-width spaces, joiners, soft hyphens) and control characters but space. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\p{Cf}\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;

/** Lower case, without accents and invisible characters, compatibility forms folded (NFKD), `+` as a space, each run of space as one. */
function folded(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE, '').replace(/\+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Text as an address and private Flux text are compared (#1065): percent-decoded, then lower case, without accents or invisible
 * characters, compatibility forms folded, `+` as a space and each run of space characters as one space.
 */
export function comparableText(text: string): string {
  return folded(percentLayers(text, TEXT_DECODE_PASSES).at(-1)!);
}

/**
 * A site named without a scheme (`wiki.example/lamp`, `news.example`): labels, a top level in lower-case letters, not inside an email
 * address, a longer name or an address with a scheme; then its path, if any.
 */
const BARE_SITE = /(?<![\p{L}\p{N}@._/-])(?:[\p{L}\p{N}-]+\.)+\p{Ll}{2,63}(?![\p{L}\p{N}@-]|\.[\p{L}\p{N}])(?:[/:?#][^\s<>"'`\\^{}|]*)?/gu;

/** Where a compared address starts: after its scheme and a leading `www.` (`news.example/2026/lamps`). */
const withoutScheme = (compared: string) => compared.replace(/^https?:\/\/(?:www\.)?/, '');
/** An address as the check compares it: comparable, without its scheme, `www.` and fragment. */
const comparedAddress = (address: string) => withoutScheme(comparableText(address));

/** Private Flux text as a run keeps it for the check (#1065, C-30): comparable, and the web addresses written in it. */
export interface KeptPrivateText { body: string; addresses: string[] }

/**
 * Keeps private Flux text a run read for the check (#1065): its comparable form without the web addresses written in it, so that a page a
 * person named (`https://news.example/2026/11/09/lamps`, `wiki.example/lamp`) still opens and its words refuse no other address; and
 * those addresses as the check compares them, so that one carried to another site is refused (`privateFragmentIn`). Only the address is
 * left out, never the words around it (a tool's JSON has no spaces between its fields), and an email address is not an address.
 */
export function keptPrivateText(text: string): KeptPrivateText {
  const addresses = new Set<string>();
  const leaveOut = (raw: string, scheme: string) => {
    const kept = withoutTrailingMarks(raw);
    const address = normalizedAddress(`${scheme}${kept}`);
    if (!address) return raw;
    if (addresses.size < WRITTEN_ADDRESSES) addresses.add(comparedAddress(address));
    return ` ${raw.slice(kept.length)}`;
  };
  const body = text.replace(ADDRESS, (raw) => leaveOut(raw, '')).replace(BARE_SITE, (raw) => leaveOut(raw, 'https://'));
  return { body: comparableText(body), addresses: [...addresses] };
}

/**
 * Whether a window of compared text can be a fragment: 12 characters with at least 6 letters or digits, of two words or more, with a
 * digit or with an `@` (an email address, a handle). One long word alone ("documentation", a name) is too common to tell what a run read
 * from what everybody writes.
 */
function fragmentLike(window: string): boolean {
  return (window.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= FRAGMENT_LETTERS && /[\s\p{N}@]/u.test(window);
}

/** The host (and port) a compared address without its scheme begins with. */
const siteOf = (address: string) => /^[^/?#\s]*/.exec(address)![0];

/**
 * What of an address written in private text (`written`, compared, without its scheme) a reading of another site's address carries: the
 * whole address, when it names more than its site, or a long part of its path or query (12 characters or more, with a digit, a space or an
 * `@`: an id, a token). A date or a word of its path alone is not its part: another site's page of the same day opens.
 */
function carriedPart(reading: string, written: string): string | null {
  const path = written.slice(siteOf(written).length);
  if (path.length > 1 && containsWhole(reading, written)) return written;
  for (const part of path.split(/[/?&=#;]+/)) if (part.length >= PRIVATE_FRAGMENT_CHARS && fragmentLike(part) && containsWhole(reading, part)) return part;
  return null;
}

/** Whether `text` holds `whole` with no letter or digit glued to either end of it (`x.example/a` is not in `box.example/abc`). */
function containsWhole(text: string, whole: string): boolean {
  const glued = /[\p{L}\p{N}-]/u;
  for (let at = text.indexOf(whole); at >= 0; at = text.indexOf(whole, at + 1)) {
    const before = at > 0 ? text[at - 1]! : '';
    const after = text[at + whole.length] ?? '';
    if (!glued.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
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
 * Every way the address can carry text to a site (#1065): as the agent wrote it and as the server sends it (the URL parser drops tabs and
 * line breaks and encodes the host), with its host in Unicode, each percent-decoded as often as it was encoded; and the hex, base64 and
 * base32 runs of the decoded address, decoded. The fragment (`#…`) is never sent and is not read. Null when it is no address (nothing is sent).
 */
function readingsOf(address: string): { plain: string[]; decoded: string[] } | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  url.hash = '';
  const unicodeHost = domainToUnicode(url.hostname);
  const sources = new Set([address.split('#')[0]!, url.href, unicodeHost ? url.href.replace(url.hostname, unicodeHost) : url.href]);
  const plain = new Set<string>();
  const decoded = new Set<string>();
  for (const source of sources) {
    const layers = addressLayers(source);
    for (const layer of layers) plain.add(withoutScheme(folded(layer).trim()));
    for (const run of decodedRuns(layers[layers.length - 1]!)) decoded.add(folded(run));
  }
  return { plain: [...plain], decoded: [...decoded] };
}

/**
 * The first fragment of private Flux text the run read (`texts`, kept by `keptPrivateText`) that `address` carries (#1065, C-30), in
 * any of its readings, or an address written in that text that it carries to another site: the server refuses to open it. Null when it
 * carries none.
 */
export function privateFragmentIn(address: string, texts: readonly KeptPrivateText[]): string | null {
  const readings = readingsOf(address);
  if (!readings) return null;
  for (const { addresses } of texts) {
    for (const written of addresses) {
      for (const plain of readings.plain) {
        const carried = siteOf(plain) === siteOf(written) ? null : carriedPart(plain, written);
        if (carried) return carried.slice(0, 80);
      }
      for (const decoded of readings.decoded) {
        const carried = carriedPart(decoded, written);
        if (carried) return carried.slice(0, 80);
      }
    }
  }
  const windows = new Set<string>();
  for (const compared of [...readings.plain, ...readings.decoded]) {
    for (let at = 0; at + PRIVATE_FRAGMENT_CHARS <= compared.length; at++) {
      const window = compared.slice(at, at + PRIVATE_FRAGMENT_CHARS);
      if (fragmentLike(window)) windows.add(window);
    }
  }
  if (!windows.size) return null;
  for (const { body } of texts) {
    for (let at = 0; at + PRIVATE_FRAGMENT_CHARS <= body.length; at++) {
      const window = body.slice(at, at + PRIVATE_FRAGMENT_CHARS);
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
