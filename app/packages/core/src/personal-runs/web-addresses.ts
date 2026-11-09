import { domainToUnicode } from 'node:url';

// Web addresses in a run (#918, #953, #954, #1065, F-036 AG-8, C-30). Since the founder's direction of 2026-11-09 an agent may open ANY
// public address. An address is still a way to send something to a site (`http://site/collect?d=<what the agent knows>`), so the server
// refuses one that carries private Flux text the run read (`privateFragmentIn`): written into it as it was, percent-encoded, in other case
// or accents, with invisible characters, spelled in hidden characters, or as a run of hex, base64 or base32. A link written in that text
// opens, and a redirect hop may carry only the text of the link the read began with (#1136). The brief tells the agent never to put anything from Flux into an
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

/** Where kept words were cut: a link left out of them. No window of an address can span it: a compared address never holds a line break. */
const CUT = '\n';
/** The cut in the text as written, before it is compared: a private-use character that folding keeps. */
const CUT_MARK = '\uE000';
/**
 * A date or a date and time (C-30, #1136) as both sides read it: one mark that is no letter, digit or space, so a window spans it but a
 * date alone makes no fragment, and which date it was does not count. Folding drops control characters, so no compared text holds it.
 */
const DATE = '\u0001';
/**
 * A date, a real one (a month 1–12, a day 1–31, a year 1900–2099), written ISO-style or with slashes or dots either way round
 * (`2026-11-09`, `2026/11/09`, `09.11.2026`, `11/09/2026`), with the time after it if there is one (`2026-11-09t08:15:30.123z`, the
 * brief's `2026-11-09 08:15`). A tool's `createdAt` and today's date are in every run; "what changed since this morning" is ordinary work.
 * A time alone is not a date (`12:34` can be a door code). Read in compared (lower-case) text.
 */
const DATE_TIME = /(?<!\d)(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}))(?:[t ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?(?:z|[+-]\d{2}(?::?\d{2})?)?)?(?!\d)/g;
const inRange = (value: string | undefined, low: number, high: number) => value !== undefined && Number(value) >= low && Number(value) <= high;
function datesMarked(compared: string): string {
  return compared.replace(DATE_TIME, (match, year, month, day, first, second, year2, hour, minute, seconds) => {
    const date = year !== undefined ? inRange(year, 1900, 2099) && inRange(month, 1, 12) && inRange(day, 1, 31)
      : inRange(year2, 1900, 2099) && ((inRange(first, 1, 31) && inRange(second, 1, 12)) || (inRange(first, 1, 12) && inRange(second, 1, 31)));
    if (!date) return match;
    const length = year !== undefined ? year.length + month.length + day.length + 2 : first.length + second.length + year2.length + 2;
    const time = hour !== undefined && inRange(hour, 0, 23) && inRange(minute, 0, 59) && (seconds === undefined || inRange(seconds, 0, 60));
    return time ? DATE : `${DATE}${match.slice(length)}`;
  });
}

/** A web address as the check compares it: comparable, without its scheme, `www.` and fragment, its dates marked. */
const comparedAddress = (address: string) => datesMarked(withoutScheme(comparableText(address)));

/** The links inside a link's query: a redirect wrapper's target (`google.com/url?q=https://…`). */
function wrappedTargets(address: string): string[] {
  const targets: string[] = [];
  for (const value of new URL(address).searchParams.values()) {
    const target = /^https?:\/\//i.test(value) ? normalizedAddress(value) : null;
    if (target && targets.length < 4) targets.push(target);
  }
  return targets;
}

/** The web addresses written in a text, normalized, each once, with the text cut where each was: one with a scheme, or a site named without one. */
function cutAddresses(text: string, found: (address: string) => void): string {
  const leaveOut = (raw: string, scheme: string) => {
    const kept = withoutTrailingMarks(raw);
    const address = normalizedAddress(`${scheme}${kept}`);
    if (!address) return raw;
    found(address);
    return `${CUT_MARK}${raw.slice(kept.length)}`;
  };
  return text.replace(ADDRESS, (raw) => leaveOut(raw, '')).replace(BARE_SITE, (raw) => leaveOut(raw, 'https://'));
}

/**
 * Private Flux text as a run keeps it for the check (#1065, #1136, C-30): `body`, its words, compared, with each link cut out and each date
 * marked; `addresses`, the links written in it, compared (and a wrapper's target as a link too).
 */
export interface KeptPrivateText { body: string; addresses: string[] }

/**
 * Keeps private Flux text a run read for the check (#1065, #1136): its words, compared, with the web addresses written in it cut out (an
 * address with a scheme, or a site named without one, such as `wiki.example/lamp`; never the words around it, since a tool's JSON has no
 * spaces between its fields; an email address is not an address) and its dates marked; and those addresses, compared, with the target
 * inside a redirect wrapper's query. Linear in the text; `keepPrivateText` does it in slices for a long text.
 */
export function keptPrivateText(text: string): KeptPrivateText {
  const links = new Set<string>();
  const keep = (address: string, depth: number) => {
    links.add(comparedAddress(address));
    if (depth < WRAPPED_DEPTH) for (const target of wrappedTargets(address)) keep(target, depth + 1);
  };
  const words = cutAddresses(text, (address) => keep(address, 0));
  return { body: datesMarked(comparableText(words)).replaceAll(CUT_MARK, CUT), addresses: [...links] };
}

/** How much text is kept, indexed or read between two yields to the event loop: about a millisecond's work. */
const SLICE = 1 << 15;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Work counted in characters; every `SLICE` of it, the event loop gets a turn (#1136: no step of the check holds it for long). */
class Pacer {
  private left = SLICE * 8;
  async spend(characters: number) {
    this.left -= characters;
    if (this.left <= 0) { this.left = SLICE * 8; await yieldToLoop(); }
  }
}

/**
 * `keptPrivateText` for a text of any size, in slices of about 32 KiB cut after a character no address holds (a space, a quote, a bracket)
 * when one is near, with a turn of the event loop between them (#1136: a 256 KiB tool result of bare site names took about 80 ms in one go).
 */
export async function keepPrivateText(text: string): Promise<KeptPrivateText> {
  if (text.length <= SLICE) return keptPrivateText(text);
  const bodies: string[] = [];
  const links = new Set<string>();
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + SLICE);
    if (to < text.length) {
      // A long run with no such character (`a.ab,a.ab,…`) is cut where it is: a link across the cut is kept as two pieces of private text.
      const stop = text.slice(to, to + 4096).search(/[\s"'<>]/);
      if (stop >= 0) to += stop + 1;
    }
    const kept = keptPrivateText(text.slice(from, to));
    bodies.push(kept.body);
    for (const address of kept.addresses) links.add(address);
    from = to;
    await yieldToLoop();
  }
  return { body: bodies.join(''), addresses: [...links] };
}

/**
 * The web addresses written in a text, as they would be read (#1138): an agent's change that writes one carrying private text the run
 * read is refused, so a later read of it cannot pass the check as a link a person wrote.
 */
export function writtenAddresses(text: string): string[] {
  const found = new Set<string>();
  cutAddresses(text, (address) => found.add(address));
  return [...found];
}

// A rolling hash of 12-character windows (Rabin-Karp): one pass over the run's kept text finds which of the address's windows stand in it,
// whatever the number of links or texts. The multiplier is random for each process, so text cannot be made to collide with an address.
const W = PRIVATE_FRAGMENT_CHARS;
const BASE = (Math.floor(Math.random() * 0x3fffffff) * 2 + 1) | 0;
const BASE_POW = Array.from({ length: W - 1 }).reduce<number>((power) => Math.imul(power, BASE), 1);
const hashOf = (text: string, at: number) => { let hash = 0; for (let i = 0; i < W; i++) hash = (Math.imul(hash, BASE) + text.charCodeAt(at + i)) | 0; return hash; };
/** The same polynomial hash over a whole string: a link is found among the prefixes of an address in one pass. */
const wholeHash = (text: string) => { let hash = 0; for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) | 0; return hash; };

/** The host (and port) a compared address without its scheme begins with. */
const siteOf = (address: string) => /^[^/?#\s]*/.exec(address)![0];
/**
 * Whether two sites are one for the host-and-path rule (#1136): the same host, or one a subdomain of the other (`github.com` and
 * `api.github.com`, `example.com` and `docs.example.com`); never two subdomains side by side (`docs.google.com` and `script.google.com`,
 * `a.github.io` and `b.github.io`), and no list of public suffixes to keep.
 */
const sameSite = (one: string, other: string) => one === other || one.endsWith(`.${other}`) || other.endsWith(`.${one}`);

/** The links one kept text added, joined by line breaks, with where each starts and its site. */
interface LinkBlock { text: string; starts: number[]; sites: string[] }

/**
 * What a run's check reads (#1136): all the text the run kept, its words and its links each once, built as the text is kept and reused by
 * every check of the run. Adding a text yields to the event loop as it goes, so a million links never hold it.
 */
export class PrivateTextIndex {
  readonly words: string[] = [];
  readonly blocks: LinkBlock[] = [];
  private readonly wordSet = new Set<string>();
  /** Each link once, by its whole hash, in 256 small maps: one big map would rehash a million entries at once. */
  private readonly linkHashes = Array.from({ length: 256 }, () => new Map<number, string[]>());
  private links = 0;
  /** The longest link kept: no prefix of an address beyond it can be one. */
  longestLink = 0;
  /** Characters held, for the cache's bound. */
  size = 0;

  get linkCount() { return this.links; }

  private linksWith(hash: number): string[] | undefined { return this.linkHashes[hash & 255]!.get(hash); }

  async add(kept: KeptPrivateText, pacer = new Pacer()): Promise<void> {
    if (kept.body.trim() && !this.wordSet.has(kept.body)) { this.wordSet.add(kept.body); this.words.push(kept.body); this.size += kept.body.length; }
    const block: LinkBlock = { text: '', starts: [], sites: [] };
    const parts: string[] = [];
    let at = 0;
    for (const link of kept.addresses) {
      const hash = wholeHash(link);
      const same = this.linksWith(hash);
      if (same?.includes(link)) continue;
      if (same) same.push(link); else this.linkHashes[hash & 255]!.set(hash, [link]);
      this.links++;
      this.longestLink = Math.max(this.longestLink, link.length);
      block.starts.push(at);
      block.sites.push(siteOf(link));
      parts.push(link);
      at += link.length + 1;
      this.size += link.length;
      await pacer.spend(link.length + 64);
    }
    if (parts.length) { block.text = parts.join(CUT); this.blocks.push(block); }
  }

  /** The longest link kept that `compared` is, or begins with followed by a mark of a path or a query (`doc/edit` → `doc/edit?usp=sharing`). */
  writtenPrefix(compared: string): string | null {
    const most = Math.min(compared.length, this.longestLink);
    let hash = 0;
    let found: string | null = null;
    const match = (length: number) => (this.linksWith(hash) ?? []).find((link) => link.length === length && compared.startsWith(link)) ?? null;
    // One pass: the hash of each prefix in turn, looked up where the prefix ends at a mark or where the address ends.
    for (let end = 1; end <= most; end++) {
      hash = (Math.imul(hash, BASE) + compared.charCodeAt(end - 1)) | 0;
      const last = compared[end - 1]!;
      const next = compared[end];
      if (end === compared.length || '/?&;=#'.includes(last) || (next !== undefined && '/?&;=#'.includes(next))) found = match(end) ?? found;
    }
    return found;
  }
}

/** A run's kept texts as one index, built at once (a test, a probe): the server keeps one per run and adds to it (`run-private-text.ts`). */
export async function privateTextIndex(texts: readonly KeptPrivateText[]): Promise<PrivateTextIndex> {
  const index = new PrivateTextIndex();
  const pacer = new Pacer();
  for (const kept of texts) await index.add(kept, pacer);
  return index;
}

/**
 * One read's addresses, the address asked for and each redirect hop after it (#1136): a hop may carry again the text of the link written in
 * the private text that the FIRST address was or began with (a page a person named: DOI → publisher, twitter.com → x.com, a GitHub
 * permalink → raw.githubusercontent.com). Nothing else carries over: a page that opened only because its site's path may carry a link's
 * text passes none of it on (`www.google.com/amp/s/evil.example/<id>` and its redirect to `evil.example/<id>`).
 */
export interface AddressChain { started: boolean; named: Set<string> }
export const addressChain = (): AddressChain => ({ started: false, named: new Set<string>() });

/** An address longer than the tool takes, as it would be sent (#1136): it is neither checked nor read. */
export class AddressTooLong extends Error {
  constructor() { super('The address is longer than a web address may be'); }
}

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
    const code = text.charCodeAt(i);
    if (code < 128) {
      letters[i] = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90) ? 1 : 0;
      marks[i] = (code >= 48 && code <= 57) || code === 64 || code === 32 || (code >= 9 && code <= 13) ? 1 : 0;
    } else {
      const char = text[i]!;
      letters[i] = ALNUM.test(char) ? 1 : 0;
      marks[i] = MARK.test(char) ? 1 : 0;
    }
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

/** A part of an address as it is compared: folded, its dates marked. */
const readable = (text: string) => datesMarked(folded(revealed(text)));

/**
 * Every way the address can carry text to a site (#1065), as windows: its host and path, then its query, as the server sends it (the URL
 * parser drops tabs and line breaks and encodes the host) and with its host in Unicode, each percent-decoded as often as it was encoded and
 * with any hidden text revealed and its dates marked; and the hex, base64 and base32 runs of the decoded address, decoded. The fragment
 * (`#…`) is never sent and is not read. Null when it is no web address (nothing is sent); `AddressTooLong` when, as sent, it is longer than
 * `ADDRESS_MAX` (a redirect's `Location` is not bounded by the tool's input). Linear in the address, bounded by `ADDRESS_MAX`.
 */
function readingsOf(address: string): { windows: Map<string, number>; compared: string } | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  if (url.href.length > ADDRESS_MAX) throw new AddressTooLong();
  const hosts = new Set([url.host]);
  const unicode = domainToUnicode(url.hostname);
  if (unicode && unicode !== url.hostname) hosts.add(url.port ? `${unicode}:${url.port}` : unicode);
  const paths = addressLayers(url.pathname);
  const queries = addressLayers(url.search);
  const windows = new Map<string, number>();
  for (const host of hosts) {
    for (let layer = 0; layer < Math.max(paths.length, queries.length); layer++) {
      const hostPath = readable(`${host}${paths[Math.min(layer, paths.length - 1)]!}`).replace(/^www\./, '');
      addWindows(`${hostPath}${readable(queries[Math.min(layer, queries.length - 1)]!)}`, hostPath.length, windows);
    }
  }
  for (const run of [...decodedRuns(`${url.host}${revealed(paths.at(-1)!)}`), ...decodedRuns(revealed(queries.at(-1)!))]) addWindows(readable(run), 0, windows);
  return { windows, compared: comparedAddress(url.href) };
}

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
  scan(text: string, from: number, to: number, hit: (candidate: Candidate, at: number) => string | null): string | null {
    if (from >= to) return null;
    const { bits, table, shift } = this;
    let hash = hashOf(text, from);
    for (let at = from; ; at++) {
      const slot = hash >>> shift;
      if (bits[slot >>> 5]! & (1 << (slot & 31))) {
        for (const candidate of table.get(hash) ?? []) {
          if (text.startsWith(candidate.window, at)) { const refused = hit(candidate, at); if (refused) return refused; }
        }
      }
      if (at + 1 >= to) return null;
      hash = (Math.imul(hash - Math.imul(text.charCodeAt(at), BASE_POW), BASE) + text.charCodeAt(at + W)) | 0;
    }
  }
}

/** The index of the link a position of a block's text lies in. */
function linkAt(starts: readonly number[], at: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle]! <= at) low = middle; else high = middle - 1; }
  return low;
}

/**
 * The fragment of private Flux text the run read that `address` carries (#1065, #1136, C-30), or null: the server refuses to open it. A
 * fragment is a 12-character window of a reading of the address (with at least 6 letters or digits and a space, a digit or an `@`) that
 * stands in the run's words, or in a link written in its private text. These do not count:
 * - the text of a link written in the private text that the address is, or begins with (a page a person named, its page 2, `?raw=true`);
 *   and, on a redirect hop, the text of the link the read's first address was or began with (`chain`);
 * - in its host and path, the text of a link of the same site or a subdomain of it either way (`docs/d/<id>/edit` → `docs/d/<id>/export`,
 *   `github.com/o/r/issues/1` → `api.github.com/repos/o/r/issues/1`); never in its query, where a form or a search on that site could
 *   collect it (`docs.google.com/forms/…/formResponse?entry.1=<id>`).
 * Its work is bounded by `ADDRESS_MAX` and one pass over the kept text, and it yields to the event loop as it goes. Throws `AddressTooLong`.
 */
export async function privateFragmentIn(address: string, index: PrivateTextIndex, chain: AddressChain = addressChain()): Promise<string | null> {
  const readings = readingsOf(address);
  if (!readings) return null;
  const named = index.writtenPrefix(readings.compared);
  const allowed = new Map<string, number>();
  if (named) addWindows(named, 0, allowed);
  if (!chain.started) {
    chain.started = true;
    for (const window of allowed.keys()) chain.named.add(window);
  }
  if (named === readings.compared) return null;
  const open = [...readings.windows].filter(([window]) => !chain.named.has(window) && !allowed.has(window));
  if (!open.length) return null;
  const candidates = new Candidates(open, open.length);
  const site = siteOf(readings.compared);
  const pacer = new Pacer();
  const read = async (text: string, hit: (candidate: Candidate, at: number) => string | null): Promise<string | null> => {
    for (let from = 0, last = text.length - W + 1; from < last;) {
      const to = Math.min(last, from + SLICE * 8);
      const refused = candidates.scan(text, from, to, hit);
      if (refused) return refused;
      await pacer.spend(to - from);
      from = to;
    }
    await pacer.spend(16);
    return null;
  };
  // The links first, in one pass: a window found in a link of the address's own site (or a subdomain of it either way) lies in that link's
  // text; one found anywhere else in the query or a decoded run is refused at once. A host-and-path window found in another site's link is
  // refused at the end, unless a link of its own site held it too.
  const elsewhere = new Set<Candidate>();
  for (const block of index.blocks) {
    const refused = await read(block.text, (candidate, at) => {
      if (candidate.where & ELSEWHERE) return candidate.window;
      if (sameSite(site, block.sites[linkAt(block.starts, at)]!)) candidate.sameSite = true; else elsewhere.add(candidate);
      return null;
    });
    if (refused) return refused;
  }
  for (const candidate of elsewhere) if (!candidate.sameSite) return candidate.window;
  const inWords = (candidate: Candidate) => (candidate.where & ELSEWHERE || !candidate.sameSite ? candidate.window : null);
  for (const words of index.words) { const refused = await read(words, inWords); if (refused) return refused; }
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
