import { decodeEntities, parsePagePreview } from '../link-previews/html.js';

// The text of a web page for an agent that reads it (#918, F-036 AG-8): plain text and a title, bounded, from the start of the page.
// Nothing of the page's markup is kept: no script, style, link target, image or form ever reaches the agent, and the text is data
// the agent is told never to obey. One linear pass over the page, so a hostile page (unclosed quotes, thousands of open tags)
// cannot make it slow.

/** The most characters of a page one read returns; it keeps the tool's answer far under the MCP route's bound. */
export const READ_TEXT_MAX = 8_000;

/** Elements whose content is not text for a reader. */
// `head` is not one of them: a page that leaves out `</head>` (minified pages often do) would be read as nothing but its head. Its `title`,
// `script` and `style` are skipped on their own, and its `meta` and `link` have no text.
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'textarea', 'title', 'iframe', 'object', 'canvas', 'select']);
/** Elements that end a line. */
const BLOCK = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'header',
  'footer', 'main', 'aside', 'nav', 'blockquote', 'pre', 'hr', 'figure', 'figcaption', 'details', 'summary', 'form', 'fieldset']);

/** Control characters other than the line break, the line and paragraph separators, the byte order mark and the bidirectional marks and overrides: a space. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
/**
 * Characters a reader never sees and an instruction can hide in (#953): the zero-width space, the word joiner and the invisible operators, the
 * soft hyphen, the Mongolian, Hangul and Khmer fillers, the combining grapheme joiner, and the tag characters and variation selectors
 * supplement (U+E0000 to U+E0FFF), which can spell a whole text no one can read. They are removed, not turned into a space, so a word with a
 * soft hyphen stays one word. The zero-width joiner and non-joiner stay: emoji and several scripts need them.
 */
// eslint-disable-next-line no-misleading-character-class -- the combining characters are listed on purpose: they are what is removed
const INVISIBLE = /[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b\u2060-\u2064\u3164\uffa0]|[\u{e0000}-\u{e0fff}]/gu;

export interface ReadablePage {
  title: string | null;
  text: string;
  /** The page had more text than one read returns. */
  truncated: boolean;
}

/** Plain text of an HTML page's body, or of a plain text page when `html` is false. */
export function readablePage(source: string, html: boolean): ReadablePage {
  const title = html ? parsePagePreview(source).title : null;
  const pieces: string[] = [];
  let length = 0;
  // More than the cap survives the clean-up of any real page; stopping the scan here keeps a hostile one from costing more.
  const room = READ_TEXT_MAX * 3;
  const push = (text: string) => { pieces.push(text); length += text.length; };
  if (!html) push(source.slice(0, room));
  let i = 0;
  while (html && i < source.length && length < room) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { push(source.slice(i, i + room)); break; }
    if (lt > i) push(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    // A declaration (`<!doctype html>`) or a processing instruction is markup, not words.
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const close = source.indexOf('>', lt + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    const named = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source.slice(lt, lt + 40));
    if (!named) { push('<'); i = lt + 1; continue; }
    let end = lt + named[0].length;
    let quote = '';
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    if (end >= source.length) break;
    const name = named[2]!.toLowerCase();
    const closing = named[1] === '/';
    i = end + 1;
    if (!closing && RAW_TEXT.has(name)) {
      const stop = new RegExp(`</${name}\\b`, 'gi');
      stop.lastIndex = i;
      const found = stop.exec(source);
      if (!found) break;
      i = found.index;
      continue;
    }
    if (BLOCK.has(name)) push('\n');
  }
  const cleaned = decodeEntities(pieces.join('')).replace(INVISIBLE, '').replace(UNSAFE, ' ')
    .split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const characters = [...cleaned];
  const truncated = characters.length > READ_TEXT_MAX || length >= room;
  return { title, text: truncated ? characters.slice(0, READ_TEXT_MAX).join('').trimEnd() : cleaned, truncated };
}
