import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { SEARCH_FILTER_TYPES, type SearchFilterType, type SearchKind, type SearchResponse, type SearchResult } from '@flux/contracts';
import { Button, EmptyState, Icon, MEDIA, Spinner, Select, Option, useMediaQuery } from '../ui';
import { PhoneSearchPage, type Scope } from './JumpTo';
import { useShellData } from '../app/data';
import { targetHref } from './api';
import { useRecentSearches } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import { UnsearchedSpaces } from '../encryption/LockedSpace';
import './search.css';
import { RefLink } from '../place/origin';
import { currentEntry, onPlacesForgotten, useArrival, usePlaceState } from '../place/memory';

/** The answer each search page showed, by person and history entry, for a return to it. Never stored. */
const answers = new Map<string, { q: string; type: SearchFilterType | null; place: string | null; answer: SearchResponse; items: SearchResult[] }>();
onPlacesForgotten(() => answers.clear());
const FILTER_LABELS: Record<SearchFilterType, string> = {
  project: 'Projects', message: 'Messages', doc: 'Wiki', material: 'Files', work: 'Tasks', decision: 'Decisions', result: 'Results',
  sketch: 'Map', draft: 'Drafts', person: 'People',
};

/** The groups a results page is shown in (#514), in order. */
const GROUPS: { id: string; label: string; kinds: SearchKind[] }[] = [
  { id: 'doc', label: 'Wiki', kinds: ['doc'] },
  { id: 'work', label: 'Tasks', kinds: ['work', 'decision', 'result'] },
  { id: 'map', label: 'Map', kinds: ['sketch', 'thought', 'draft'] },
  { id: 'message', label: 'Messages', kinds: ['message', 'dm_message'] },
  { id: 'material', label: 'Files', kinds: ['material'] },
  { id: 'people', label: 'People and projects', kinds: ['project', 'person'] },
];
/** Rows a group shows before "Show N more". */
const GROUP_ROWS = 3;

function isFilter(value: string | null): value is SearchFilterType {
  return !!value && (SEARCH_FILTER_TYPES as readonly string[]).includes(value);
}

/** A page address's kind as the phone's chips name it; the other kinds are searched under All. */
const CHIP_OF: Partial<Record<SearchFilterType, Scope>> = { work: 'tasks', doc: 'wiki', person: 'people' };

/**
 * `/search`: on the phone the one search the round Search button opens (#763 SE-2), with its chips, Cancel and recent places;
 * on the computer the whole answer with its filters.
 */
export function SearchPage() {
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? <PhoneSearch /> : <FullSearch />;
}

function PhoneSearch() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { me } = useShellData();
  const type = params.get('type');
  const place = params.get('place');
  // The address is read once, as the page opens; afterwards the words typed keep it in step (replace, no new history).
  const [start] = useState(() => ({
    query: params.get('q') ?? '', chip: (isFilter(type) ? CHIP_OF[type] : undefined) ?? 'all' as Scope,
    project: place?.startsWith('project:') ? place.slice('project:'.length) : null,
  }));
  return <PhoneSearchPage userId={me.user.id} start={{
    ...start,
    onQuery: (query) => setParams((current) => {
      const next = new URLSearchParams(current);
      if (query.trim()) next.set('q', query.trim()); else next.delete('q');
      return next;
    }, { replace: true, state: location.state }),
    onCancel: () => { if (location.key !== 'default') void navigate(-1); else void navigate('/'); },
  }} />;
}

/**
 * `/search?q=&type=&place=` (#114): the whole answer with filters for the kind of result and the
 * place. Counts beside the filters include only what the person may open. Results are ordinary
 * links; ↑ and ↓ move between them.
 */
function FullSearch() {
  const [params, setParams] = useSearchParams();
  // A replace on this page keeps the entry's state, so the origin it was followed from stays (#592).
  const location = useLocation();
  const { me, projects, directMessages } = useShellData();
  const recent = useRecentSearches(me.user.id);
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  // On the phone the chip row scrolls sideways; a soft fade at its edge says it continues (#514, #438-6).
  const [continues, setContinues] = useState(false);
  // The groups opened with "Show more" are still open on return (#592).
  const arrival = useArrival();
  const [opened, setOpened] = usePlaceState<string[]>('search.open', () => [], arrival, (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
  const open = useMemo(() => new Set(opened), [opened]);
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const typeParam = params.get('type');
  const type = isFilter(typeParam) ? typeParam : null;
  const place = params.get('place');
  // Back to this page shows the answer it had, while the same request is read again (#592). Kept in memory only, per person.
  const [seed] = useState(() => {
    const kept = arrival ? answers.get(`${me.user.id}:${arrival.key}`) : undefined;
    return kept && kept.q === q.trim() && kept.type === type && kept.place === place ? kept : null;
  });
  const { state, loadMore, moreBusy, retry } = useSearch(draft, { type, place, limit: 20, initial: seed });
  useEffect(() => {
    if (state.status !== 'ready') return;
    answers.delete(`${me.user.id}:${currentEntry().key}`);
    answers.set(`${me.user.id}:${currentEntry().key}`, { q: draft.trim(), type, place, answer: state.answer, items: state.items });
    for (const key of [...answers.keys()].slice(0, Math.max(0, answers.size - 12))) answers.delete(key);
  }, [state, me.user.id, draft, type, place, location.key]);

  // Keep the address in step with what is typed, without adding history for every key.
  useEffect(() => {
    if (draft.trim() === q.trim()) return;
    const timer = window.setTimeout(() => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (draft.trim()) next.set('q', draft.trim()); else next.delete('q');
        return next;
      }, { replace: true, state: location.state });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, q, setParams, location.state]);

  const set = (key: 'type' | 'place', value: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (draft.trim()) next.set('q', draft.trim());
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true, state: location.state });
  };

  const answer = state.status === 'ready' ? state.answer : state.status === 'loading' ? state.previous : null;
  const items = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  const counts = answer?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  useEffect(() => {
    const row = filtersRef.current;
    if (!row) return;
    const measure = () => setContinues(row.scrollWidth - row.scrollLeft - row.clientWidth > 2);
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { row.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [answer, type, place]);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a.sr') ?? [])];
    if (!links.length) return;
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowUp' && index <= 0) { if (index === 0) { event.preventDefault(); document.getElementById(inputId)?.focus(); } return; }
    event.preventDefault();
    links[event.key === 'ArrowDown' ? Math.min(index + 1, links.length - 1) : index - 1]?.focus();
  };
  const onResultClick = () => recent.remember(draft);

  return (
    <div className="pane-scroll">
      <div className="pane-in search" data-shift onKeyDown={moveFocus}>
        <form className="search__form" role="search" onSubmit={(event) => { event.preventDefault(); recent.remember(draft); set('type', type); }}>
          <label className="ui-vh" htmlFor={inputId}>Search Flux</label>
          <div className="search__field">
            <Icon name="search" size={16} className="search__icon" />
            <input id={inputId} className="search__input" type="search" value={draft} autoFocus={!q} enterKeyHint="search" autoComplete="off" spellCheck={false}
              placeholder="Search messages, materials, tasks, decisions, people…" onChange={(event) => setDraft(event.target.value)} />
            {state.status === 'loading' ? <Spinner /> : null}
          </div>
        </form>

        <div className="search__filters" ref={filtersRef} data-continues={continues}>
          <div className="search__chips" role="group" aria-label="Kind of result">
            <button type="button" className="search__chip" aria-pressed={!type} onClick={() => set('type', null)}>
              All{answer && draft.trim() ? <span className="search__n">{total}{answer.countsCapped ? '+' : ''}</span> : null}
            </button>
            {SEARCH_FILTER_TYPES.map((filter) => {
              const n = counts[filter] ?? 0;
              if (!n && type !== filter) return null;
              return (
                <button key={filter} type="button" className="search__chip" aria-pressed={type === filter} onClick={() => set('type', type === filter ? null : filter)}>
                  {FILTER_LABELS[filter]}<span className="search__n">{n}</span>
                </button>
              );
            })}
          </div>
          {/* The place filter is the last chip of the kind row (#514); outside the group, which names kinds only. */}
          <div className="search__place">
            <Select aria-label="Place" value={place ?? ''} onChange={(next) => set('place', next || null)}>
              <Option value="">All places</Option>
              {projects.map((project) => <Option key={project.id} value={`project:${project.id}`}># {project.name}</Option>)}
              {directMessages.map((dm) => <Option key={dm.id} value={`dm:${dm.id}`}>{dm.title}</Option>)}
              <Option value="private">Only you</Option>
            </Select>
          </div>
        </div>

        <p className="ui-vh" role="status">{state.status === 'ready' ? (items.length ? `${total}${state.answer.countsCapped ? '+' : ''} ${total === 1 ? 'result' : 'results'}` : 'No results') : ''}</p>
        {/* F-030 (#655): encrypted spaces this search did not look into, said above the results. */}
        {draft.trim() && answer ? <UnsearchedSpaces tooLarge={answer.sealedUnavailable ?? []} /> : null}

        {!draft.trim() ? (
          recent.items.length ? (
            <section className="search__recent" aria-labelledby={`${inputId}-recent`}>
              <div className="search__recent-h"><h2 id={`${inputId}-recent`}>Recent searches</h2><button type="button" className="ui-link" onClick={() => recent.clear()}>Clear</button></div>
              <ul>{recent.items.map((item) => <li key={item}><button type="button" className="search__again" onClick={() => setDraft(item)}><Icon name="search" size={13} />{item}</button></li>)}</ul>
              <p className="search__note">Recent searches stay on this device and are removed when you sign out.</p>
            </section>
          ) : (
            <div className="view-empty"><EmptyState icon="search" title="Search everything you can open" level={2}>
              <p>Messages in your projects and direct messages, materials and every version of them, tasks, decisions, results, maps, your private drafts and people.</p>
            </EmptyState></div>
          )
        ) : state.status === 'failed' ? (
          <p className="search__problem" role="alert"><Icon name="alert" size={14} />{state.message}<button type="button" className="ui-link" onClick={retry}>Retry</button></p>
        ) : items.length ? (
          <>
            <div ref={listRef} role="region" aria-label="Results" aria-busy={state.status === 'loading'}>
              {GROUPS.map((group) => {
                const found = items.filter((result) => group.kinds.includes(result.kind));
                if (!found.length) return null;
                const expanded = open.has(group.id);
                const shown = expanded ? found : found.slice(0, GROUP_ROWS);
                return (
                  <section className="search__group" key={group.id} aria-label={group.label}>
                    <h2 className="search__group-h">{group.label}</h2>
                    <ol className="search__list">
                      {shown.map((result: SearchResult) => (
                        <li key={result.id}>
                          <RefLink className="sr" to={targetHref(result.target)} onClick={onResultClick}><ResultBody result={result} /></RefLink>
                        </li>
                      ))}
                    </ol>
                    {found.length > GROUP_ROWS && !expanded ? (
                      <button type="button" className="ui-link search__group-more" onClick={() => setOpened((current) => current.includes(group.id) ? current : [...current, group.id])}>Show {found.length - GROUP_ROWS} more</button>
                    ) : null}
                  </section>
                );
              })}
            </div>
            {answer?.next ? <div className="search__more"><Button variant="secondary" busy={moreBusy} onClick={() => void loadMore()}>Show more results</Button></div> : null}
          </>
        ) : state.status === 'ready' ? (
          <div className="view-empty"><EmptyState icon="search" mascot="looking" title={`Nothing matches “${draft.trim()}”`} level={2}>
            <p>{!/[\p{L}\p{N}]{2,}/u.test(draft) ? 'Type at least two letters of a word.' : type || place ? 'Try all kinds and all places, or fewer words.' : 'Try fewer or different words. Only what you can open is searched.'}</p>
            {type || place ? <p><button type="button" className="ui-link" onClick={() => { const next = new URLSearchParams({ q: draft.trim() }); setParams(next, { replace: true, state: location.state }); }}>Search everywhere</button></p> : null}
          </EmptyState></div>
        ) : null}
      </div>
    </div>
  );
}
