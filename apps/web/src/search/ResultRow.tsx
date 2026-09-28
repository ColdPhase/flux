import type { SearchKind, SearchPlace, SearchResult, SearchText } from '@flux/contracts';
import { Icon, type IconName } from '../ui';

// One search result in direction C: what it is in human language, the matching text with the
// matched words marked, and where it lives, who wrote it and when. Shared by Jump to… and the page.

const ICONS: Record<SearchKind, IconName> = {
  message: 'chat', dm_message: 'chat', material: 'doc', work: 'tasks', decision: 'rule', result: 'result',
  sketch: 'map', thought: 'map', draft: 'lock', person: 'people',
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function when(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time.format(date);
  return date.getFullYear() === now.getFullYear() ? day.format(date) : dayYear.format(date);
}

export function Highlighted({ parts }: { parts: SearchText }) {
  return <>{parts.map((part, index) => (part.match ? <mark key={index} className="sr__hit">{part.text}</mark> : <span key={index}>{part.text}</span>))}</>;
}

export function placeText(place: SearchPlace) {
  switch (place.type) {
    case 'project': return `# ${place.name}`;
    case 'dm': return `With ${place.name}`;
    case 'workspace': return place.name;
    default: return 'Only you';
  }
}

/** The body of a row; the caller supplies the element (a link on the page, an option in Jump to…). */
export function ResultBody({ result }: { result: SearchResult }) {
  // In a DM with the author, "With Ari · Ari" would say the same thing twice.
  const author = result.kind === 'person' || (result.place.type === 'dm' && result.place.name === result.author) ? null : result.author;
  const meta = [result.label, placeText(result.place), author].filter(Boolean);
  return (
    <>
      <span className={`sr__ic sr__ic--${result.kind}`} aria-hidden="true"><Icon name={ICONS[result.kind]} size={15} /></span>
      <span className="sr__main">
        <span className="sr__title"><Highlighted parts={result.title} /></span>
        {result.snippet ? <span className="sr__snip"><Highlighted parts={result.snippet} /></span> : null}
        <span className="sr__meta">
          {meta.map((item, index) => (
            <span key={index} className={index === 1 ? 'sr__place' : undefined}>
              {index === 1 && result.place.type === 'private' ? <Icon name="lock" size={11} /> : null}{item}
            </span>
          ))}
          {result.kind === 'person' ? null : <time className="sr__metatime" dateTime={result.at}>{when(result.at)}</time>}
        </span>
      </span>
      {result.kind === 'person' ? null : <time className="sr__when" dateTime={result.at}>{when(result.at)}</time>}
    </>
  );
}
