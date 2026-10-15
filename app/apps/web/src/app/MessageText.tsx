import { Fragment, type ReactNode } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Icon, Kreska } from '../ui';
import '../composer/attachments.css';

// Inline references in a message's text (#348, F-026 §6): `@person`, `#4` and a Wiki page `[[Title]]`
// are chips on the text baseline; a web address is a link with a preview card under the text. The
// stored body is unchanged: this only reads it. This is the one renderer of mentions: with the project's
// people, a known name (also one with a space, such as "Jonas Berg") is one chip, and an agent's chip
// carries the Kreska mark.

const URL_TOKEN = String.raw`https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The inline references in a body, longest known names first; a web address is always group `url`. */
function tokens(names: string[]): RegExp {
  const known = names.length ? String.raw`|(?<klead>^|[\s(])(?<known>@(?:${names.map(escapeRe).join('|')}))(?![\p{L}\p{N}])` : '';
  return new RegExp(String.raw`(?<url>${URL_TOKEN})${known}|(?<mlead>^|[\s(])(?<mention>@[\p{L}][\p{L}\p{M}'-]*)|(?<tlead>^|[\s(])#(?<task>\d{1,6})\b|\[\[(?<wiki>[^\]\n]{1,120})\]\]`, 'gu');
}

const initials = (name: string) => name.slice(0, 2).toUpperCase();

/**
 * The body as text with inline chips and links. `linked={false}` keeps a web address as plain text, for a
 * surface that is itself a link (a nested anchor is invalid); its preview card still comes from LinkPreviews.
 */
export function MessageText({ body, linked = true, people = null }: { body: string; linked?: boolean; people?: ProjectPerson[] | null }) {
  const names = [...(people ?? [])].sort((a, b) => b.name.length - a.name.length);
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(tokens(names.map((person) => person.name)))) {
    const groups = match.groups!;
    const lead = groups.mlead ?? groups.klead ?? groups.tlead ?? '';
    const start = match.index! + lead.length;
    if (start > last) parts.push(body.slice(last, start));
    if (groups.url) parts.push(linked ? <a key={key++} className="msg-link" href={groups.url} target="_blank" rel="noopener noreferrer nofollow">{groups.url}</a> : <span key={key++}>{groups.url}</span>);
    else if (groups.known || groups.mention) {
      const name = (groups.known ?? groups.mention!).slice(1);
      const agent = names.find((person) => person.name === name)?.kind === 'agent';
      parts.push(<span key={key++} className={`ref-chip ref-chip--person${agent ? ' ref-chip--agent' : ''}`} data-ref="person">
        {agent ? <Kreska size={12} className="ref-chip__k" /> : <span className="ref-chip__face" aria-hidden="true" data-initials={initials(name)} />}
        <span className="ui-vh">@</span>{name}</span>);
    }
    else if (groups.task) parts.push(<span key={key++} className="ref-chip ref-chip--task" data-ref="task"><Icon name="tasks" size={12} />#{groups.task}</span>);
    else if (groups.wiki) parts.push(<span key={key++} className="ref-chip ref-chip--wiki" data-ref="wiki"><Icon name="doc" size={12} />{groups.wiki}</span>);
    last = match.index! + match[0].length;
  }
  if (!parts.length) return <>{body}</>;
  if (last < body.length) parts.push(body.slice(last));
  return <>{parts.map((part, index) => <Fragment key={`t${index}`}>{part}</Fragment>)}</>;
}

/** A readable title from a web address alone: no page is fetched for it, so nothing leaves the reader's browser. */
function addressTitle(url: URL) {
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (!segment) return url.hostname.replace(/^www\./, '');
  try { return decodeURIComponent(segment).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').trim() || url.hostname; } catch { return segment; }
}

/** A preview card for each web address in the text (at most three): the site, its domain and a title read from the address. */
export function LinkPreviews({ body }: { body: string }) {
  const urls = [...new Set([...body.matchAll(tokens([]))].map((match) => match.groups?.url).filter((url): url is string => !!url))].slice(0, 3);
  const cards = urls.flatMap((raw) => { try { return [{ raw, url: new URL(raw) }]; } catch { return []; } });
  if (!cards.length) return null;
  return <ul className="link-previews" aria-label={cards.length === 1 ? 'Link preview' : 'Link previews'}>{cards.map(({ raw, url }) => <li key={raw}>
    <a className="link-preview" href={raw} target="_blank" rel="noopener noreferrer nofollow">
      <span className="link-preview__site"><Icon name="link" size={12} />{url.hostname.replace(/^www\./, '')}</span>
      <strong>{addressTitle(url)}</strong>
      {/* The address fallback: no page is fetched, so this is the URL, not the page's own description (still open, #469). */}
      <small>{url.pathname.length > 1 ? `${url.hostname}${url.pathname}` : 'Opens in a new tab'}</small>
    </a>
  </li>)}</ul>;
}
