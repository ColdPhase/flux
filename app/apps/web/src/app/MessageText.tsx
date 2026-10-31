import { Fragment, type ReactNode } from 'react';
import { LINK_URL_SOURCE, type ProjectPerson } from '@flux/contracts';
import { Icon, Kreska, initials } from '../ui';
import { useLinkPreviews } from './linkPreviews';
import '../composer/attachments.css';

// Inline references in a message's text (#348, F-026 §6): `@person`, `#4` and a Wiki page `[[Title]]`
// are chips on the text baseline; a web address is a link with a preview card under the text. The
// stored body is unchanged: this only reads it. This is the one renderer of mentions: with the project's
// people, a known name (also one with a space, such as "Jonas Berg") is one chip, and an agent's chip
// carries the Kreska mark.

const URL_TOKEN = LINK_URL_SOURCE;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The inline references in a body, longest known names first; a web address is always group `url`. */
function tokens(names: string[]): RegExp {
  const known = names.length ? String.raw`|(?<klead>^|[\s(])(?<known>@(?:${names.map(escapeRe).join('|')}))(?![\p{L}\p{N}])` : '';
  return new RegExp(String.raw`(?<url>${URL_TOKEN})${known}|(?<mlead>^|[\s(])(?<mention>@[\p{L}][\p{L}\p{M}'-]*(?:(?<=['’]s) assistant\b)?)|(?<tlead>^|[\s(])#(?<task>\d{1,6})\b|\[\[(?<wiki>[^\]\n]{1,120})\]\]`, 'gu');
}

/**
 * The body as text with inline chips and links. `linked={false}` keeps a web address as plain text, for a
 * surface that is itself a link (a nested anchor is invalid); its preview card still comes from LinkPreviews.
 */
export function MessageText({ body, linked = true, people = null }: { body: string; linked?: boolean; people?: ProjectPerson[] | null }) {
  const names = [...(people ?? [])].sort((a, b) => b.name.length - a.name.length);
  const inline = (text: string, keyPrefix: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (const match of text.matchAll(tokens(names.map((person) => person.name)))) {
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
      last = match.index! + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
  const lines = body.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    if (!/^>\s?/.test(lines[i]!)) {
      const plain: string[] = [];
      while (i < lines.length && !/^>\s?/.test(lines[i]!)) plain.push(lines[i++]!);
      blocks.push(<Fragment key={`p${i}`}>{inline(plain.join('\n'), `p${i}-`)}</Fragment>);
      continue;
    }
    const quoted: string[] = [];
    while (i < lines.length && /^>\s?/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^>\s?/, ''));
    const first = quoted[0] ?? '';
    const attribution = /^.{1,120}:$/.test(first) ? first.slice(0, -1) : null;
    const text = attribution ? quoted.slice(1).join('\n') : quoted.join('\n');
    blocks.push(<blockquote key={`q${i}`} className="msg-quote" aria-label={attribution ? `Quoted message from ${attribution}` : 'Quoted message'}>
      {attribution ? <cite className="msg-quote__author">{attribution}</cite> : null}
      <span className="msg-quote__text">{inline(text, `q${i}-`)}</span>
    </blockquote>);
  }
  return <>{blocks}</>;
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
