import MarkdownIt, { type Token } from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { DOC_REF_TYPES, type DocMention, type DocRefType } from '@flux/contracts';
import type { DocReference, DocRenderer } from '@flux/core';

// The doc Markdown subset (#112): paragraphs, headings, emphasis, strikethrough, lists, quotes,
// code, tables, rules and links. Two independent layers keep it safe:
// 1. markdown-it with raw HTML disabled (it is escaped as text), images disabled, and links
//    limited to http(s), mailto, same-app paths and `flux:` references;
// 2. sanitize-html on the output with an allowlist of tags, attributes, classes and schemes.
// `flux:<type>/<id>` links become app links to objects of the project, or quiet plain text
// when the object is missing or outside the project.

const REF = new RegExp(`^flux:(${DOC_REF_TYPES.join('|')})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, 'i');
const SAFE_LINK = /^(https?:\/\/|mailto:|flux:|\/(?!\/)|#)/i;

function parseRef(href: string): DocReference | null {
  const match = REF.exec(href.trim());
  return match ? { type: match[1]!.toLowerCase() as DocRefType, id: match[2]!.toLowerCase() } : null;
}

function engine() {
  const md = new MarkdownIt('default', { html: false, linkify: true, typographer: false, breaks: false });
  md.disable(['image']);
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  // Checked after markdown-it decodes entities and escapes, so `java&#115;cript:` is caught too.
  md.validateLink = (url) => SAFE_LINK.test(url.trim());
  return md;
}

const md = engine();

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
    'a', 'span', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  allowedAttributes: {
    a: ['href', 'class', 'data-ref-type', 'data-ref-id', 'target', 'rel'],
    span: ['class'], code: ['class'], ol: ['start'], th: ['style'], td: ['style'],
  },
  allowedClasses: { a: ['doc-ref'], span: ['doc-ref', 'doc-ref--missing'], code: [/^language-[a-z0-9_+-]{1,32}$/] },
  allowedStyles: { th: { 'text-align': [/^(left|right|center)$/] }, td: { 'text-align': [/^(left|right|center)$/] } },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'escape',
  transformTags: {
    // External links open outside the app and pass no opener or referrer.
    a: (tagName, attribs) => (/^https?:/i.test(attribs.href ?? '')
      ? { tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }
      : { tagName, attribs: { ...Object.fromEntries(Object.entries(attribs).filter(([name]) => name !== 'target' && name !== 'rel')) } }),
  },
};

/** Rewrites `flux:` links for one render: resolved ones to app links, missing ones to plain text. */
function rewriteReferences(tokens: Token[], mentions: Map<string, DocMention>) {
  for (const token of tokens) {
    if (token.children) rewriteReferences(token.children, mentions);
    if (token.type !== 'link_open') continue;
    const href = String(token.attrGet('href') ?? '');
    if (!/^flux:/i.test(href)) continue;
    const ref = parseRef(href);
    const mention = ref ? mentions.get(`${ref.type}:${ref.id}`) : undefined;
    const close = tokens.slice(tokens.indexOf(token) + 1).find((item) => item.type === 'link_close');
    if (ref && mention?.path) {
      token.attrs = [['href', mention.path], ['class', 'doc-ref'], ['data-ref-type', ref.type], ['data-ref-id', ref.id]];
    } else {
      token.tag = 'span';
      token.attrs = [['class', 'doc-ref doc-ref--missing']];
      if (close) close.tag = 'span';
    }
  }
}

function collect(tokens: Token[], found: DocReference[]) {
  for (const token of tokens) {
    if (token.children) collect(token.children, found);
    if (token.type === 'link_open') {
      const ref = parseRef(String(token.attrGet('href') ?? ''));
      if (ref) found.push(ref);
    }
  }
  return found;
}

export const markdownRenderer: DocRenderer = {
  references: (markdown) => collect(md.parse(markdown, {}), []),
  render(markdown, mentions) {
    const tokens = md.parse(markdown, {});
    rewriteReferences(tokens, mentions);
    return sanitizeHtml(md.renderer.render(tokens, md.options, {}), SANITIZE);
  },
};
