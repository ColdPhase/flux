/**
 * What a page says about itself, read from the start of its HTML and nothing else (#469): the title and the description.
 * No HTML is kept: both values are returned as plain text of bounded length, so a reader that renders them as text (React
 * escapes it) can never be handed markup, and no script, style, image or link of the page is ever read.
 */
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 300;

export interface PagePreview { title: string | null; description: string | null }

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', middot: '·', bull: '•' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (whole, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
}

/** Control characters, line and paragraph separators, the byte order mark and the bidirectional overrides, which can reorder what is read. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f]/g;

/** One line of plain text: entities decoded once, tags dropped (also those written as entities), unsafe characters and runs of white space collapsed, cut to `max`. */
export function plainText(raw: string, max: number): string | null {
  // Far more than `max` survives tag removal of any real value; the cut keeps a hostile value from making the passes slow.
  const text = decodeEntities(raw.slice(0, 8 * max)).replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max - 1).join('').trimEnd()}…` : text;
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.replace(/^<meta/i, '').matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!result.has(name)) result.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'textarea']);
const MAX_META = 200;

/**
 * Only `<title>`, `og:title`, `og:description` and `<meta name="description">`; Open Graph wins over the plain tags. One linear
 * pass, so a hostile page (unclosed quotes, thousands of open tags) cannot make the scan slow; it stops at `</head>` or `<body>`.
 */
export function parsePagePreview(html: string): PagePreview {
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let metaDescription: string | null = null;
  let pageTitle: string | null = null;
  let metas = 0;
  let i = 0;
  while (i < html.length && metas < MAX_META) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const named = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 40));
    if (!named) { i = lt + 1; continue; }
    let end = lt + named[0].length;
    let quote = '';
    for (; end < html.length; end++) {
      const c = html[end]!;
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    if (end >= html.length) break;
    const tag = html.slice(lt, end + 1);
    const name = named[2]!.toLowerCase();
    const closing = named[1] === '/';
    i = end + 1;
    if (closing && name === 'head') break;
    if (!closing && name === 'body') break;
    if (!closing && name === 'meta') {
      metas++;
      const attrs = attributes(tag);
      const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
      const content = attrs.get('content');
      if (content === undefined) continue;
      if (key === 'og:title') ogTitle ??= plainText(content, TITLE_MAX);
      else if (key === 'og:description') ogDescription ??= plainText(content, DESCRIPTION_MAX);
      else if (key === 'description') metaDescription ??= plainText(content, DESCRIPTION_MAX);
    } else if (!closing && (name === 'title' || RAW_TEXT.has(name))) {
      const stop = new RegExp(`</${name}\\b`, 'gi');
      stop.lastIndex = i;
      const found = stop.exec(html);
      if (!found) break;
      if (name === 'title' && pageTitle === null) pageTitle = plainText(html.slice(i, found.index), TITLE_MAX);
      i = found.index;
    }
  }
  return { title: ogTitle ?? pageTitle, description: ogDescription ?? metaDescription };
}
