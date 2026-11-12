import { Fragment, useMemo, type ReactNode } from 'react';
import { LINK_URL_SOURCE, parseMessage, type MessageInline, type ProjectPerson } from '@flux/contracts';
import { Icon, Kreska, initials } from '../ui';
import { CodeBlock } from './CodeBlock';
import { useLinkPreviews } from './linkPreviews';
import '../composer/attachments.css';
import './message-format.css';

// The one renderer of a message's text (#348, F-026 §6, #1247): reusable wherever Markdown-subset text is shown (a message, a direct
// message, a reply, a task's discussion, an agent's chat and answer). It reads the stored body and builds React elements, never HTML, so
// no text can add a tag or an attribute. The text may carry `**bold**`, `*italic*`, `inline code`, fenced code, `- `/`1. ` lists and `>`
// quotes (`parseMessage` in @flux/contracts is the one parser); anything else stays as typed. Inline references are chips on the text
// baseline: `@person`, `#4` and a Wiki page `[[Title]]`; a web address is a link with a preview card under the text. The stored body is
// unchanged: this only reads it. With the project's people, a known name (also one with a space, such as "Jonas Berg") is one chip, and
// an agent's chip carries the Kreska mark.

const URL_TOKEN = LINK_URL_SOURCE;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The inline references in a body, longest known names first; a web address is always group `url`; `[3]` is group `cite` when asked for. */
function tokens(names: string[], cites = false): RegExp {
  const known = names.length ? String.raw`|(?<klead>^|[\s(])(?<known>@(?:${names.map(escapeRe).join('|')}))(?![\p{L}\p{N}])` : '';
  const cite = cites ? String.raw`|\[(?<cite>\d{1,3})\]` : '';
  return new RegExp(String.raw`(?<url>${URL_TOKEN})${known}|(?<mlead>^|[\s(])(?<mention>@[\p{L}][\p{L}\p{M}'-]*(?:(?<=['’]s) assistant\b)?)|(?<tlead>^|[\s(])#(?<task>\d{1,6})\b|\[\[(?<wiki>[^\]\n]{1,120})\]\]${cite}`, 'gu');
}

/**
 * The body as formatted text with inline chips and links. `linked={false}` keeps a web address as plain text, for a surface that is
 * itself a link (a nested anchor is invalid); its preview card still comes from LinkPreviews. `cite` turns a `[3]` of an assistant's answer
 * into what the caller draws for source 3 (null leaves the text as it is).
 */
export function MessageText({ body, linked = true, people = null, cite }: { body: string; linked?: boolean; people?: ProjectPerson[] | null; cite?: (index: number) => ReactNode | null }) {
  const names = [...(people ?? [])].sort((a, b) => b.name.length - a.name.length);
  const blocks = useMemo(() => parseMessage(body), [body]);
  const reference = tokens(names.map((person) => person.name), cite !== undefined);
  /** A run of plain text: the references in it as chips and links. */
  const chips = (text: string, keyPrefix: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (const match of text.matchAll(reference)) {
      const groups = match.groups!;
      const lead = groups.mlead ?? groups.klead ?? groups.tlead ?? '';
      const start = match.index! + lead.length;
      if (start > last) parts.push(text.slice(last, start));
      if (groups.url) parts.push(linked ? <a key={`${keyPrefix}${key++}`} className="msg-link" href={groups.url} target="_blank" rel="noopener noreferrer nofollow">{groups.url}</a> : <span key={`${keyPrefix}${key++}`}>{groups.url}</span>);
      else if (groups.known || groups.mention) {
        const name = (groups.known ?? groups.mention!).slice(1);
        const agent = names.find((person) => person.name === name)?.kind === 'agent' || /['’]s assistant$/.test(name);
        parts.push(<span key={`${keyPrefix}${key++}`} className={`ref-chip ref-chip--person${agent ? ' ref-chip--agent' : ''}`} data-ref="person">
          {agent ? <Kreska size={12} className="ref-chip__k" /> : <span className="ref-chip__face" aria-hidden="true" data-initials={initials(name)} />}
          <span className="ui-vh">@</span>{name}</span>);
      }
      else if (groups.task) parts.push(<span key={`${keyPrefix}${key++}`} className="ref-chip ref-chip--task" data-ref="task"><Icon name="tasks" size={12} />#{groups.task}</span>);
      else if (groups.wiki) parts.push(<span key={`${keyPrefix}${key++}`} className="ref-chip ref-chip--wiki" data-ref="wiki"><Icon name="doc" size={12} />{groups.wiki}</span>);
      else if (groups.cite) {
        const source = cite?.(Number(groups.cite)) ?? null;
        parts.push(source === null ? match[0] : <Fragment key={`${keyPrefix}${key++}`}>{source}</Fragment>);
      }
      last = match.index! + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
  /** Text with its marks: bold, italic and code, the references inside them kept (code is the exception: it is only text). */
  const inline = (nodes: MessageInline[], keyPrefix: string): ReactNode[] => nodes.flatMap<ReactNode>((node, index): ReactNode[] => {
    const key = `${keyPrefix}${index}`;
    switch (node.kind) {
      case 'text': return chips(node.text, `${key}-`);
      case 'bold': return [<strong key={key} className="msg-strong">{inline(node.children, `${key}-`)}</strong>];
      case 'italic': return [<em key={key} className="msg-em">{inline(node.children, `${key}-`)}</em>];
      case 'code': return [<code key={key} className="msg-code">{node.text}</code>];
    }
  });
  return <>{blocks.map((block, index) => {
    switch (block.kind) {
      case 'text': return <Fragment key={`p${index}`}>{inline(block.inline, `p${index}-`)}</Fragment>;
      case 'quote': return <blockquote key={`q${index}`} className="msg-quote" aria-label={block.author ? `Quoted message from ${block.author}` : 'Quoted message'}>
        {block.author ? <cite className="msg-quote__author">{block.author}</cite> : null}
        <span className="msg-quote__text">{inline(block.inline, `q${index}-`)}</span>
      </blockquote>;
      case 'list': {
        const items = block.items.map((item, at) => <li key={at}>{inline(item, `l${index}-${at}-`)}</li>);
        return block.ordered ? <ol key={`l${index}`} className="msg-list" start={block.start}>{items}</ol> : <ul key={`l${index}`} className="msg-list">{items}</ul>;
      }
      case 'code': return <CodeBlock key={`c${index}`} code={block.text} lang={block.lang} />;
    }
  })}</>;
}

/** A readable title from a web address alone: the reader's browser fetches no page. */
function addressTitle(url: URL) {
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (!segment) return url.hostname.replace(/^www\./, '');
  try { return decodeURIComponent(segment).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').trim() || url.hostname; } catch { return segment; }
}

/**
 * A preview card for each web address in the text (at most three): the site, its domain, a title and three lines under it. With the
 * page's own title and description (fetched by the server when the operator allows it, #469) those are shown; until then, and for
 * a page that says nothing, the title is read from the address and the third line is the address.
 */
export function LinkPreviews({ body, projectId, messageId }: { body: string; projectId: string; messageId: string | null }) {
  const fetched = useLinkPreviews(projectId, messageId, body);
  const urls = [...new Set([...body.matchAll(tokens([]))].map((match) => match.groups?.url).filter((url): url is string => !!url))].slice(0, 3);
  const cards = urls.flatMap((raw) => { try { return [{ raw, url: new URL(raw) }]; } catch { return []; } });
  if (!cards.length) return null;
  return <ul className="link-previews" aria-label={cards.length === 1 ? 'Link preview' : 'Link previews'}>{cards.map(({ raw, url }) => {
    const page = fetched.get(raw);
    return <li key={raw}>
      <a className="link-preview" href={raw} target="_blank" rel="noopener noreferrer nofollow" data-page={page?.description ? 'described' : page?.title ? 'titled' : 'address'}>
        <span className="link-preview__site"><Icon name="link" size={12} />{url.hostname.replace(/^www\./, '')}</span>
        <strong>{page?.title ?? addressTitle(url)}</strong>
        <small>{page?.description ?? (url.pathname.length > 1 ? `${url.hostname}${url.pathname}` : 'Opens in a new tab')}</small>
      </a>
    </li>;
  })}</ul>;
}
