import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SEARCH_FILTER_TYPES, type SearchFilterType, type SearchResult } from '@flux/contracts';
import { Button, EmptyState, Icon, Spinner } from '../ui';
import { useShellData } from '../app/data';
import { detailsOf, targetHref } from './api';
import { useOpenResult } from './JumpTo';
import { useRecentSearches } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import './search.css';

const FILTER_LABELS: Record<SearchFilterType, string> = {
  message: 'Messages', doc: 'Docs', material: 'Materials', work: 'Tasks', decision: 'Decisions', result: 'Results',
  sketch: 'Sketches', draft: 'Drafts', person: 'People',
};

function isFilter(value: string | null): value is SearchFilterType {
  return !!value && (SEARCH_FILTER_TYPES as readonly string[]).includes(value);
}

/**
 * `/search?q=&type=&place=` (#114): the whole answer with filters for the kind of result and the
 * place. Counts beside the filters include only what the person may open. Results are ordinary
 * links; ↑ and ↓ move between them.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { me, projects, directMessages } = useShellData();
  const recent = useRecentSearches(me.user.id);
  const openResult = useOpenResult();
  const inputId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const typeParam = params.get('type');
  const type = isFilter(typeParam) ? typeParam : null;
  const place = params.get('place');
  const { state, loadMore, moreBusy, retry } = useSearch(draft, { type, place, limit: 20 });

  // Keep the address in step with what is typed, without adding history for every key.
  useEffect(() => {
    if (draft.trim() === q.trim()) return;
    const timer = window.setTimeout(() => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (draft.trim()) next.set('q', draft.trim()); else next.delete('q');
        return next;
      }, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, q, setParams]);

  const set = (key: 'type' | 'place', value: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (draft.trim()) next.set('q', draft.trim());
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  };

  const answer = state.status === 'ready' ? state.answer : state.status === 'loading' ? state.previous : null;
  const items = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  const counts = answer?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a.sr') ?? [])];
    if (!links.length) return;
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowUp' && index <= 0) { if (index === 0) { event.preventDefault(); document.getElementById(inputId)?.focus(); } return; }
    event.preventDefault();
    links[event.key === 'ArrowDown' ? Math.min(index + 1, links.length - 1) : index - 1]?.focus();
  };
  const onResultClick = (event: MouseEvent<HTMLAnchorElement>, result: SearchResult) => {
    recent.remember(draft);
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !detailsOf(result.target)) return;
    event.preventDefault();
    openResult(result);
  };

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

        <div className="search__filters">
          <div className="search__place">
            <select aria-label="Place" value={place ?? ''} onChange={(event) => set('place', event.target.value || null)}>
              <option value="">All places</option>
              {projects.map((project) => <option key={project.id} value={`project:${project.id}`}># {project.name}</option>)}
              {directMessages.map((dm) => <option key={dm.id} value={`dm:${dm.id}`}>{dm.title}</option>)}
              <option value="private">Only you</option>
            </select>
          </div>
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
        </div>

        <p className="ui-vh" role="status">{state.status === 'ready' ? (items.length ? `${total} results` : 'No results') : ''}</p>

        {!draft.trim() ? (
          recent.items.length ? (
            <section className="search__recent" aria-labelledby={`${inputId}-recent`}>
              <div className="search__recent-h"><h2 id={`${inputId}-recent`}>Recent searches</h2><button type="button" className="ui-link" onClick={() => recent.clear()}>Clear</button></div>
              <ul>{recent.items.map((item) => <li key={item}><button type="button" className="search__again" onClick={() => setDraft(item)}><Icon name="search" size={13} />{item}</button></li>)}</ul>
              <p className="search__note">Recent searches stay on this device and are removed when you sign out.</p>
            </section>
          ) : (
            <div className="view-empty"><EmptyState icon="search" title="Search everything you can open" level={2}>
              <p>Messages in your projects and direct messages, materials and every version of them, tasks, rules, results, sketches, your private drafts and people.</p>
            </EmptyState></div>
          )
        ) : state.status === 'failed' ? (
          <p className="search__problem" role="alert"><Icon name="alert" size={14} />{state.message}<button type="button" className="ui-link" onClick={retry}>Retry</button></p>
        ) : items.length ? (
          <>
            <ol className="search__list" ref={listRef} aria-label="Results" aria-busy={state.status === 'loading'}>
              {items.map((result) => (
                <li key={result.id}>
                  <Link className="sr" to={targetHref(result.target)} onClick={(event) => onResultClick(event, result)}><ResultBody result={result} /></Link>
                </li>
              ))}
            </ol>
            {answer?.next ? <div className="search__more"><Button variant="secondary" busy={moreBusy} onClick={() => void loadMore()}>Show more results</Button></div> : null}
          </>
        ) : state.status === 'ready' ? (
          <div className="view-empty"><EmptyState icon="search" title={`Nothing matches “${draft.trim()}”`} level={2}>
            <p>{!/[\p{L}\p{N}]{2,}/u.test(draft) ? 'Type at least two letters of a word.' : type || place ? 'Try all kinds and all places, or fewer words.' : 'Try fewer or different words. Only what you can open is searched.'}</p>
            {type || place ? <p><button type="button" className="ui-link" onClick={() => { const next = new URLSearchParams({ q: draft.trim() }); setParams(next, { replace: true }); }}>Search everywhere</button></p> : null}
          </EmptyState></div>
        ) : null}
      </div>
    </div>
  );
}
