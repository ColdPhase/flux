import { Fragment, type ReactNode } from 'react';
import { removedName, type SearchKind, type SearchPlace, type SearchResult, type SearchText } from '@flux/contracts';
import { Icon, Kreska, StatusGlyph, TASK_STATE_WORD, type IconName } from '../ui';
import { plainSnippet } from './plain';
import { useRouteLoaderData } from 'react-router';
import { SpaceFace } from '../ui/SpaceFace';
import { PersonPhoto } from '../ui/Avatar';
import { FileIcon } from '../composer/Attachments';
import type { ShellData } from '../app/data';
import { youLabel } from '../docs/format';

// One search result as Search.dc.html draws it (#870): a 28 px tile for what it is, the matching text with the matched
// words marked, and one line of where it lives, who wrote it and when. The groups are `groups.ts`.

const ICONS: Record<Exclude<SearchKind, 'project' | 'message' | 'dm_message' | 'file'>, IconName> = {
  work: 'tasks', doc: 'doc', decision: 'flag', sketch: 'map', thought: 'map', person: 'people',
};

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
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

/** The initials of an author's name, for the tile of a message. */
function initials(author: string | null): string {
  const words = (author ?? '').split(/\s+/).filter(Boolean);
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
    // An agent's message, or an agent's answer a person showed everyone, is its Kreska in its colour, as the message draws it (#1528).
    if (result.byAgent) {
      return <span className="sr__ic sr__ic--agent" aria-hidden="true"><Kreska size={28} {...(result.agentColour ? { hue: result.agentColour } : {})} /></span>;
    }
    const letters = initials(result.author);
    return <span className="sr__ic sr__ic--person" aria-hidden="true">{letters || <Icon name="chat" size={14} />}</span>;
  }
  return <span className={`sr__ic sr__ic--${result.kind}`} aria-hidden="true"><Icon name={ICONS[result.kind]} size={14} /></span>;
}

const plainTitle = (result: SearchResult) => result.title.map((part) => part.text).join('');

/**
 * The title as it reads: a message's or a thought's matching words are a slice of its Markdown, so they read as the message does, a Wiki
 * page's `[[Opening checklist]]` as its title and no other mark (round 15 new k).
 */
const shownTitle = (result: SearchResult): SearchText => (result.kind === 'message' || result.kind === 'dm_message' || result.kind === 'thought'
  ? plainSnippet(result.title) ?? result.title : result.title);

/** A space's tile in its result: the icon the shell knows for it (F-040), or its letter. */
function ProjectFace({ result }: { result: SearchResult }) {
  const shell = useRouteLoaderData('app') as ShellData | undefined;
  const projectId = result.target.type === 'project' ? result.target.projectId : null;
  const icon = shell?.reachableSpaces.find((space) => space.id === projectId)?.icon;
  return <SpaceFace name={plainTitle(result)} icon={icon} size={28} />;
}

/** One piece of a result's second line: a plain string, or what is drawn together with the same in words for the row's name. */
type Line = string | { text: string; node: ReactNode; quote?: boolean };
const lineText = (line: Line) => (typeof line === 'string' ? line : line.text);
const lineNode = (line: Line) => (typeof line === 'string' ? line : line.node);
const quoted = (snippet: SearchText): Line => ({ text: `“${snippet.map((part) => part.text).join('')}”`, node: <span key="snip">“<Highlighted parts={snippet} />”</span>, quote: true });
const isQuote = (line: Line) => typeof line !== 'string' && !!line.quote;
const written = (result: SearchResult): Line => ({ text: when(result.at), node: <time key="at" dateTime={result.at}>{when(result.at)}</time> });

/** The second line: the words the group does not already say, then where it lives and when it was written. */
function meta(result: SearchResult): Line[] {
  return pieces(result).filter((line): line is Line => !!line);
}

function pieces(result: SearchResult): Array<Line | null> {
  const place = result.place;
  // In a DM with the author, "With Ari · Ari" would say the same thing twice. The reader is "Kasia Wójcik (you)", as everywhere a person is
  // named as an author (design §5 "Naming people", personas-37).
  const author = result.author && !(place.type === 'dm' && (place.name === result.author || removedName(place.name) === result.author)) ? youLabel(result.author, !!result.mine) : null;
  const where = placeText(place);
  const { task } = result;
  if (task) return [`#${task.number}`, TASK_STATE_WORD[task.status], where];
  switch (result.kind) {
    case 'message': case 'dm_message': return [author, where, written(result)];
    case 'doc': {
      const snippet = plainSnippet(result.snippet);
      return snippet ? [quoted(snippet)] : [where];
    }
    case 'file': {
      // Who sent it, where and when, as a file found by its name says, then what it says where it matched (led by the page, for a PDF): two
      // files of one name sent twice are told apart by their first words, never two identical rows (round 15 new P2-3).
      const snippet = plainSnippet(result.snippet);
      const page = result.target.type === 'file' ? result.target.page : undefined;
      return snippet ? [author, where, written(result), page ? `Page ${page}` : null, quoted(snippet)] : [author, where, written(result)];
    }
    case 'thought': case 'sketch': return place.type === 'private' ? ['My map', 'only you'] : [result.label, where];
    case 'project': return [];
    case 'person': return result.label.endsWith('Guest') ? ['Guest'] : [];
    default: return [result.label, where];
  }
}

/**
 * The row's accessible name: the title, then each piece of the second line, set apart by commas. The drawn " · " is hidden from a
 * screen reader, which would otherwise run the pieces together ("Ada KowalskaCommunity garden sensors18:45").
 */
export function resultName(result: SearchResult) {
  return [personTitle(result) ?? shownTitle(result).map((part) => part.text).join(''), ...meta(result).map(lineText)].join(', ');
}

/** A person found by name who is the reader: "Ana Costa (you)", as People names them (personas-37). */
const personTitle = (result: SearchResult) => (result.kind === 'person' && result.mine ? youLabel(plainTitle(result), true) : null);

const pieceNodes = (lines: Line[]) => lines.map((line, index) => <Fragment key={index}>{index ? <span aria-hidden="true"> · </span> : null}<span>{lineNode(line)}</span></Fragment>);

/** The body of a row; the caller supplies the option element. */
export function ResultBody({ result }: { result: SearchResult }) {
  const lines = meta(result);
  const plain = result.kind === 'message' || result.kind === 'dm_message';
  return (
    <>
      <Tile result={result} />
      <span className="sr__main">
        <span className={`sr__title${plain ? ' sr__title--text' : ''}`}><Highlighted parts={shownTitle(result)} />{personTitle(result) ? <span> (you)</span> : null}</span>
        {lines.length > 1 && isQuote(lines[lines.length - 1]!) ? (
          // Who, where and when give way first, the quote with the matched words last (round 15 confirm S3: a long space name cut "Rye 720" out).
          <span className="sr__meta sr__meta--quote">
            <span className="sr__lead">{pieceNodes(lines.slice(0, -1))}</span><span className="sr__sep" aria-hidden="true"> · </span>
            <span className="sr__quote">{lineNode(lines[lines.length - 1]!)}</span>
          </span>
        ) : lines.length ? <span className="sr__meta">{pieceNodes(lines)}</span> : null}
      </span>
      <kbd className="sr__enter" aria-hidden="true">↵</kbd>
    </>
  );
}
