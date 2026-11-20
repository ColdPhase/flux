import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { flushPlace } from '../place/memory';
import { removedName, type SearchResult } from '@flux/contracts';
import { useShellData } from '../app/data';
import { Button, EmptyState, ErrorState, Icon, MEDIA, Spinner, useMediaQuery, type IconName } from '../ui';
import { leaveFocusToDestination } from '../ui/Overlay';
import { targetHref } from './api';
import { SEARCH_HINT } from './hint';
import { placeIdentity, placeOfPath, useRecentPlaces, type RecentPlace } from './recent';
import { groupResults } from './groups';
import { ResultBody, resultName } from './ResultRow';
import { useSearch } from './useSearch';
import { UnsearchedSpaces } from '../encryption/WaitingSpaces';
import './search.css';
import { focusOnOpen } from '../ui/focusField';

/** Results listed at once. There is no second page: a longer list is narrowed by typing more words. */
const RESULTS = 20;

/** The mark after the name of a person who was removed, "Stefan Kowal (removed)". */
const REMOVED_MARK = removedName('');

type Option = { id: string; section: string } & (
  | { kind: 'result'; result: SearchResult }
  | { kind: 'place'; place: RecentPlace; label: string; side?: string; icon: IconName }
  | { kind: 'command'; label: string; icon: IconName; keys?: string[]; run: () => void }
);

/**
 * A recent row as E02 draws it: the place's own name, and its kind at the end. A project's view is named by the project
 * with the view as its kind, so two views of one project read apart; a Wiki page by its own title.
 */
interface PlaceName { label: string; side?: string; icon: IconName }
const PROJECT_VIEW: Record<string, { side: string; icon: IconName }> = {
  conversation: { side: 'Conversation', icon: 'chat' }, tasks: { side: 'Tasks', icon: 'tasks' }, map: { side: 'Map', icon: 'map' },
  docs: { side: 'Wiki', icon: 'doc' },
};
const OWN_PLACE: Record<string, PlaceName> = {
  home: { label: 'Home', icon: 'home' }, 'home:tasks': { label: 'My tasks', icon: 'tasks' },
  sketchbook: { label: 'My map', icon: 'map' }, inbox: { label: 'Inbox', icon: 'inbox' },
};
const placeName = (name: PlaceName) => (name.side ? `${name.label} · ${name.side}` : name.label);

/**
 * Opens a result at its exact place (work, decisions and results in Details on Tasks). A result carries no "‹ where I came from" control: the
 * header would gain it and its name and tabs would move (a control never changes place, #1424). Back still returns to the place Search was
 * opened from, as it restores any entry (#592); `found` tells the conversation a link brought the person to one message.
 */
export function useOpenResult() {
  const navigate = useNavigate();
  return (result: SearchResult) => { flushPlace(); return navigate(targetHref(result.target), { state: { found: true } }); };
}

/**
 * Search (⌘K / Ctrl+K, the sidebar's Search and the phone's Search, #870): one field that searches everything the person may open,
 * as they type, with the results in groups by kind and no filters. Arrow keys move through the rows, Enter opens one.
 * `DeferredJumpTo` puts it in one dialog on the computer (a floating one) or a full-screen sheet on the phone, so the dialog
 * opens once and its content loads in it. It lists what it finds and, with the field empty, the places last opened and Go to Inbox: no
 * assistant, no Create group and no sidebar toggle (README S5, S16; #1376), and nothing is added to the dialog once it is on screen (#898).
 */
export function JumpToBody({ onClose, userId }: { onClose: () => void; userId: string }) {
  const phone = useMediaQuery(MEDIA.phone);
  return <SearchBody onClose={onClose} userId={userId} phone={phone} />;
}

function SearchBody({ onClose, userId, phone }: { onClose: () => void; userId: string; phone: boolean }) {
  const [query, setQuery] = useState('');
  // The highlighted option, reset to the first whenever the text changes.
  const [activeFor, setActiveFor] = useState({ text: '', index: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const statusId = useId();
  const navigate = useNavigate();
  const openResult = useOpenResult();
  // The empty field lists the places the person opened (F-026 E02).
  const recentPlaces = useRecentPlaces(userId);
  const { projects, directMessages, workspace, removedFrom } = useShellData();
  const location = useLocation();
  const text = query.trim();
  const state = useSearch(text, RESULTS);
  // Once, as the body opens.
  // A computer's cursor is in the field as the dialog opens; a touch screen opens it with no keyboard (#1546).
  useEffect(() => { focusOnOpen(inputRef.current); }, []);

  const shown = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  // With no text: up to four recent places (not the one in view, and only those the person can still open, named as
  // their header names them), then the actions with their keys as drawn (E02).
  const hereKey = placeOfPath(location.pathname)?.key;
  const here = hereKey === undefined ? undefined : placeIdentity(hereKey);
  const named = (place: RecentPlace): PlaceName | null => {
    const own = OWN_PLACE[place.key];
    if (own) return own;
    const [kind, id, view] = place.key.split(':');
    if (kind === 'dm') { const dm = directMessages.find((item) => item.id === id); return dm ? { label: dm.title, side: 'Message', icon: 'person' } : null; }
    const project = kind === 'project' ? projects.find((item) => item.id === id) : undefined;
    const shownView = view ? PROJECT_VIEW[view] : undefined;
    if (!project || !shownView) return null;
    // A Wiki page is named by its own title; the doc it folds its versions into is the place.
    return { label: view === 'docs' && place.title && /\/docs\/[^/]+$/.test(place.path) ? place.title : project.name, side: shownView.side, icon: shownView.icon };
  };
  const places = recentPlaces.filter((place) => placeIdentity(place.key) !== here)
    .flatMap((place) => { const name = named(place); return name ? [{ place, ...name }] : []; }).slice(0, 4);
  // An encrypted space that waits to be unlocked is not searched and not listed here: the sidebar and Home say it waits (#1419 item 16).
  const emptyOptions: Option[] = [
    ...places.map(({ place, label, side, icon }): Option => ({ kind: 'place', section: 'Recent', id: `place-${place.key}`, place, label, side, icon })),
    { kind: 'command', section: 'Actions', id: 'action-inbox', label: 'Go to Inbox', icon: 'inbox', keys: ['G', 'I'], run: () => navigate('/inbox') },
  ];
  const results: Option[] = groupResults(shown).flatMap((group) => group.items.map((result): Option => ({ kind: 'result', section: group.label, id: result.id, result })));
  // A person who was removed is no longer a person of the company the server searches, yet the sidebar lists the conversation with them as
  // "Stefan Kowal (removed)": typing their name finds that conversation, under People (round 14, new P3-b).
  const words = text.toLocaleLowerCase().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const removedPeople: Option[] = words.length && state.status === 'ready' ? directMessages
    .filter((dm) => dm.kind === 'pair' && dm.title.endsWith(REMOVED_MARK)
      && words.every((word) => dm.title.slice(0, -REMOVED_MARK.length).toLocaleLowerCase().split(/\s+/).some((part) => part.startsWith(word))))
    .map((dm): Option => ({ kind: 'place', section: 'People', id: `removed-dm-${dm.id}`, place: { key: `dm:${dm.id}`, path: `/dm/${dm.id}`, title: dm.title }, label: dm.title, side: 'Message', icon: 'person' })) : [];
  const lastPeople = results.map((option) => option.section).lastIndexOf('People');
  const withRemoved = lastPeople < 0 ? [...results, ...removedPeople] : [...results.slice(0, lastPeople + 1), ...removedPeople, ...results.slice(lastPeople + 1)];
  const options: Option[] = text ? withRemoved : emptyOptions;
  const current = Math.min(activeFor.text === text ? activeFor.index : 0, Math.max(options.length - 1, 0));
  const setActive = (index: number) => setActiveFor({ text, index });
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    leaveFocusToDestination();
    if (option.kind === 'place') { onClose(); navigate(option.place.path); return; }
    if (option.kind === 'command') { onClose(); option.run(); return; }
    onClose();
    void openResult(option.result);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(options.length, 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + options.length) % Math.max(options.length, 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(options[current]); }
  };

  const found = shown.length + removedPeople.length;
  const status = !text ? '' : state.status === 'loading' ? 'Searching…' : state.status === 'failed' ? state.message
    : state.status === 'ready' ? (found ? `${found}${state.answer.next ? '+' : ''} ${found === 1 ? 'result' : 'results'}` : 'No results') : '';

  const list = options.length ? (
    <ul className="jump__list" role="listbox" id={listId} aria-label={text ? 'Results' : places.length ? 'Recent places and actions' : 'Actions'}>
      {options.map((option, index) => {
        // Section names are plain text: the list holds options only, so nothing interactive sits inside it.
        const head = option.section !== options[index - 1]?.section ? <li key={`h-${option.section}`} role="presentation" className="jump__sh">{option.section}</li> : null;
        return [head, (
          <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === current}
            aria-label={option.kind === 'place' ? placeName(option) : option.kind === 'result' ? resultName(option.result) : undefined}
            className={`jump__opt${option.kind === 'result' ? ' sr' : ''}${index === current ? ' is-active' : ''}`}
            onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(option)}>
            {option.kind === 'result' ? <ResultBody result={option.result} />
              : option.kind === 'place' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.side ? <small className="jump__side">{option.side}</small> : null}</>
              : <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.keys ? <span className="jump__keys" aria-hidden="true">{option.keys.map((key) => <kbd key={key} className="jump__key">{key}</kbd>)}</span> : null}</>}
          </li>
        )];
      })}
    </ul>
  ) : null;
  // No results: Kreska looks aside (unless Settings turned the small moments off), then the words (the drawn no-results moment; the guide's S16).
  // Someone who left the company or was removed has nothing to search: Search says why, in Home's words, instead of "Nothing matches"
  // (round 14, new P3-c).
  const empty = text && state.status === 'ready' && !found ? (
    <div className="jump__none">
      {!workspace && removedFrom ? (
        <EmptyState icon="people" level={3} title={`You’re no longer in ${removedFrom}`}>
          <p>Ask an owner or admin of the company for an invite link to come back.</p>
        </EmptyState>
      ) : (
        <EmptyState mascot="looking" icon="search" level={3} title={`Nothing matches “${text}”`}>
          <p>{/[\p{L}\p{N}]{2,}/u.test(text) ? 'Try fewer or different words.' : 'Type at least two letters of a word.'}</p>
        </EmptyState>
      )}
    </div>
  ) : state.status === 'failed' ? (
    // The one error state, as every other place has it, never an 11 px line in an empty box (round 14, look-a B7).
    <div className="jump__none"><ErrorState title="Search couldn’t answer"
      actions={state.retry ? <Button variant="secondary" icon="refresh" onClick={state.retry}>Try again</Button> : undefined}><p>{state.message}</p></ErrorState></div>
  ) : null;

  // More than the dialog lists (it does not page): one quiet last line says so, and typing more words narrows the list. It stays while the
  // next answer loads, as the rows above it do, so the dialog's bottom edge does not move on each keystroke.
  const settled = state.status === 'ready' ? state.answer : state.status === 'loading' ? state.previous : null;
  const more = text && settled?.next && found
    ? <p className="jump__hint jump__more">Showing {found} · type more words to narrow</p> : null;

  return (
    <div className="jump__in">
      {phone ? <h2 className="jump__title">Search</h2> : null}
      {/* The field's row is its target: the input is a control's height inside the row (#763 sweep). */}
      <div className="jump__field" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus(); } }}>
        <Icon name="search" size={16} className="jump__icon" />
        <input ref={inputRef} className="jump__input" type="search" value={query} placeholder="Search"
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-label="Search"
          aria-describedby={statusId} aria-activedescendant={options.length ? `${listId}-${current}` : undefined}
          enterKeyHint="search" autoComplete="off" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        {state.status === 'loading' ? <Spinner /> : null}
        {/* The name holds the visible "Esc" (WCAG 2.5.3). */}
        {/* Close says its word, with its key beside it as the footer's "↵ open" and the menus do (L539); never a bare keycap as the button's only label. */}
        <button type="button" className="jump__close" onClick={onClose} aria-keyshortcuts={phone ? undefined : 'Escape'}>{phone ? 'Cancel' : <>Close<kbd aria-hidden="true">Esc</kbd></>}</button>
      </div>
      <p className="ui-vh" id={statusId} role="status">{status}</p>
      <div className="jump__body">
        {phone && !text && !places.length ? <p className="jump__hint">{SEARCH_HINT}</p> : null}
        {/* What was not searched (F-030; UI audit LK-3): an encrypted space too large to search in memory. */}
        {text && state.status === 'ready' ? <UnsearchedSpaces tooLarge={state.answer.sealedUnavailable ?? []} /> : null}
        {list}{empty}{more}
      </div>
      {phone ? null : (
        <p className="jump__foot">
          <span className="jump__hint-line">{SEARCH_HINT}</span>
          <span className="jump__keyhint" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span className="jump__keyhint" aria-hidden="true"><kbd>↵</kbd> open</span>
        </p>
      )}
    </div>
  );
}
