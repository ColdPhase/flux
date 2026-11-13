import { Fragment, type ReactNode } from 'react';
import type { SearchKind, SearchPlace, SearchResult, SearchText } from '@flux/contracts';
import { Icon, StatusGlyph, TASK_STATE_WORD, type IconName } from '../ui';
import { plainSnippet } from './plain';
import { useRouteLoaderData } from 'react-router';
import { SpaceFace } from '../ui/SpaceFace';
import { PersonPhoto } from '../ui/Avatar';
import { FileIcon } from '../composer/Attachments';
import type { ShellData } from '../app/data';

// One search result as Search.dc.html draws it (#870): a 28 px tile for what it is, the matching text with the matched
// words marked, and one line of where it lives, who wrote it and when. The results are grouped by kind, in this order.

const GROUPS: { label: string; kinds: SearchKind[] }[] = [
  { label: 'Tasks', kinds: ['work', 'decision'] },
  { label: 'Messages', kinds: ['message', 'dm_message'] },
  { label: 'Wiki', kinds: ['doc'] },
  { label: 'Files', kinds: ['file', 'material'] },
  { label: 'Thoughts', kinds: ['thought', 'sketch'] },
  { label: 'Spaces', kinds: ['project'] },
  { label: 'People', kinds: ['person'] },
];

/** The results in groups by kind; inside a group they keep the order the server ranked them in. */
export function groupResults(items: SearchResult[]): { label: string; items: SearchResult[] }[] {
  return GROUPS.flatMap((group) => {
    const found = items.filter((item) => group.kinds.includes(item.kind));
    return found.length ? [{ label: group.label, items: found }] : [];
  });
}

const ICONS: Record<Exclude<SearchKind, 'project' | 'message' | 'dm_message' | 'file'>, IconName> = {
  work: 'tasks', material: 'link', doc: 'doc', decision: 'flag', sketch: 'map', thought: 'map', person: 'people',
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

/** Where a result lives, in a few plain words. */
export function placeText(place: SearchPlace) {
  switch (place.type) {
    case 'project': return place.name;
    case 'dm': return `With ${place.name}`;
    case 'workspace': return place.name;
    default: return 'Only you';
  }
}

/** The initials of an author's name, for the tile of a message ("Ari Nowak (agent)" is "AN"). */
function initials(author: string | null): string {
  const words = (author ?? '').replace(/\s*\(agent\)$/, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
}

function Tile({ result }: { result: SearchResult }) {
  const { task } = result;
  if (task) return <span className="sr__ic sr__ic--work" aria-hidden="true"><StatusGlyph status={task.status} size={14} /></span>;
  if (result.kind === 'project') return <span className="sr__ic sr__ic--project" aria-hidden="true"><ProjectFace result={result} /></span>;
  // A person found by name: their photo over their initials (F-039). A message names its author by name only, so it keeps the initials.
  if (result.kind === 'person') {
    return <span className="sr__ic sr__ic--person" aria-hidden="true">{initials(plainTitle(result))}<PersonPhoto id={result.target.type === 'person' ? result.target.userId : null} px={28} /></span>;
  }
  // A file found by what it says (C-63): its own page icon, as the message shows it, over the tile.
  if (result.kind === 'file') return <span className="sr__ic sr__ic--file" aria-hidden="true"><FileIcon name={plainTitle(result)} size={20} /></span>;
  if (result.kind === 'message' || result.kind === 'dm_message') {
    const letters = initials(result.author);
    return <span className="sr__ic sr__ic--person" aria-hidden="true">{letters || <Icon name="chat" size={14} />}</span>;
  }
  return <span className={`sr__ic sr__ic--${result.kind}`} aria-hidden="true"><Icon name={ICONS[result.kind]} size={14} /></span>;
}

const plainTitle = (result: SearchResult) => result.title.map((part) => part.text).join('');

/** A space's tile in its result: the icon the shell knows for it (F-040), or its letter. */
function ProjectFace({ result }: { result: SearchResult }) {
  const shell = useRouteLoaderData('app') as ShellData | undefined;
  const projectId = result.target.type === 'project' ? result.target.projectId : null;
  const icon = shell?.reachableSpaces.find((space) => space.id === projectId)?.icon;
  return <SpaceFace name={plainTitle(result)} icon={icon} size={28} />;
}

/** The second line: the words the group does not already say, then where it lives and when it was written. */
function meta(result: SearchResult): ReactNode[] {
  const place = result.place;
  // In a DM with the author, "With Ari · Ari" would say the same thing twice.
  const author = result.author && !(place.type === 'dm' && place.name === result.author) ? result.author : null;
  const where = placeText(place);
  const { task } = result;
  if (task) return [`#${task.number}`, TASK_STATE_WORD[task.status], where];
  switch (result.kind) {
    case 'message': case 'dm_message': return [author, where, <time key="at" dateTime={result.at}>{when(result.at)}</time>];
    case 'doc': {
      const snippet = plainSnippet(result.snippet);
      return snippet ? [<span key="snip">“<Highlighted parts={snippet} />”</span>] : [where];
    }
    case 'file': {
      // What the file says where it matched (and the page, for a PDF); a file found by its name says where it lives.
      const snippet = plainSnippet(result.snippet);
      const page = result.target.type === 'file' ? result.target.page : undefined;
      return snippet ? [page ? `Page ${page}` : null, <span key="snip">“<Highlighted parts={snippet} />”</span>] : [author, where, <time key="at" dateTime={result.at}>{when(result.at)}</time>];
    }
    case 'thought': case 'sketch': return place.type === 'private' ? ['My map', 'only you'] : [result.label, where];
    case 'project': return [];
    case 'person': return result.label.endsWith('guest') ? ['Guest'] : [];
    default: return [result.label, where];
  }
}

/** The body of a row; the caller supplies the option element. */
export function ResultBody({ result }: { result: SearchResult }) {
  const lines = meta(result).filter(Boolean);
  const plain = result.kind === 'message' || result.kind === 'dm_message';
  return (
    <>
      <Tile result={result} />
      <span className="sr__main">
        <span className={`sr__title${plain ? ' sr__title--text' : ''}`}><Highlighted parts={result.title} /></span>
        {lines.length ? <span className="sr__meta">{lines.map((line, index) => <Fragment key={index}>{index ? <span aria-hidden="true"> · </span> : null}<span>{line}</span></Fragment>)}</span> : null}
      </span>
      <kbd className="sr__enter" aria-hidden="true">↵</kbd>
    </>
  );
}
