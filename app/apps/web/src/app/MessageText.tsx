import { Fragment, type ReactNode } from 'react';
import { Icon } from '../ui';
import '../composer/attachments.css';

// Inline references in a message's text (#348, F-026 §6): `@person`, `#4` and a Wiki page `[[Title]]`
// are chips on the text baseline; a web address is a link with a preview card under the text. The
// stored body is unchanged: this only reads it.

const TOKEN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(^|[\s(])(@[\p{L}][\p{L}\p{M}'-]*)|(^|[\s(])#(\d{1,6})\b|\[\[([^\]\n]{1,120})\]\]/gu;

const initials = (name: string) => name.slice(0, 2).toUpperCase();

/**
 * The body as text with inline chips and links. `linked={false}` keeps a web address as plain text, for a
 * surface that is itself a link (a nested anchor is invalid); its preview card still comes from LinkPreviews.
 */
export function MessageText({ body, linked = true }: { body: string; linked?: boolean }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(TOKEN)) {
    const [whole, url, mentionLead, mention, taskLead, task, wiki] = match;
    const lead = mentionLead ?? taskLead ?? '';
    const start = match.index! + lead.length;
    if (start > last) parts.push(body.slice(last, start));
    if (url) parts.push(linked ? <a key={key++} className="msg-link" href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a> : <span key={key++}>{url}</span>);
    else if (mention) parts.push(<span key={key++} className="ref-chip ref-chip--person" data-ref="person"><span className="ref-chip__face" aria-hidden="true" data-initials={initials(mention.slice(1))} /><span className="ui-vh">@</span>{mention.slice(1)}</span>);
    else if (task) parts.push(<span key={key++} className="ref-chip ref-chip--task" data-ref="task"><Icon name="tasks" size={12} />#{task}</span>);
    else if (wiki) parts.push(<span key={key++} className="ref-chip ref-chip--wiki" data-ref="wiki"><Icon name="doc" size={12} />{wiki}</span>);
    last = match.index! + whole.length;
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
  const urls = [...new Set([...body.matchAll(TOKEN)].map((match) => match[1]).filter((url): url is string => !!url))].slice(0, 3);
  const cards = urls.flatMap((raw) => { try { return [{ raw, url: new URL(raw) }]; } catch { return []; } });
  if (!cards.length) return null;
  return <ul className="link-previews" aria-label={cards.length === 1 ? 'Link preview' : 'Link previews'}>{cards.map(({ raw, url }) => <li key={raw}>
    <a className="link-preview" href={raw} target="_blank" rel="noopener noreferrer nofollow">
      <span className="link-preview__site"><Icon name="link" size={12} />{url.hostname.replace(/^www\./, '')}</span>
      <strong>{addressTitle(url)}</strong>
      <small>{url.pathname.length > 1 ? `${url.hostname}${url.pathname}` : 'Opens in a new tab'}</small>
    </a>
  </li>)}</ul>;
}
