import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import type { SearchResult } from '@flux/contracts';
import { Icon, MEDIA, Overlay, Spinner, useMediaQuery } from '../ui';
import { useShellActions } from '../app/shellContext';
import { detailsOf, targetHref } from './api';
import { useRecentSearches } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import './search.css';

type Option =
  | { kind: 'result'; id: string; result: SearchResult }
  | { kind: 'recent'; id: string; text: string }
  | { kind: 'all'; id: string };

/** Opens a result: its exact place, and Details for work, decisions and results. */
export function useOpenResult() {
  const navigate = useNavigate();
  const { openDetails } = useShellActions();
  return (result: SearchResult) => {
    navigate(targetHref(result.target));
    const details = detailsOf(result.target);
    if (details) openDetails(details);
  };
}

/**
 * Jump to… (⌘K / Ctrl+K, direction C): one field that searches everything the person may open,
 * as they type. Arrow keys move through the results, Enter opens one, and the last option opens
 * the full search page. A floating dialog on desktop, a full-screen sheet on the phone.
 */
export function JumpTo({ open, onClose, userId }: { open: boolean; onClose: () => void; userId: string }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Jump to" className="jump">
      {open ? <JumpBody onClose={onClose} userId={userId} phone={phone} /> : null}
    </Overlay>
  );
}

function JumpBody({ onClose, userId, phone }: { onClose: () => void; userId: string; phone: boolean }) {
  const [query, setQuery] = useState('');
  // The highlighted option, reset to the first whenever the text changes.
  const [activeFor, setActiveFor] = useState({ text: '', index: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const statusId = useId();
  const navigate = useNavigate();
  const openResult = useOpenResult();
  const recent = useRecentSearches(userId);
  const { state } = useSearch(query, { limit: 8 });
  const text = query.trim();
  useEffect(() => { inputRef.current?.focus(); }, []);

  const shown = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  const options: Option[] = text
    ? [...shown.map((result) => ({ kind: 'result' as const, id: result.id, result })), ...(state.status === 'ready' && shown.length ? [{ kind: 'all' as const, id: 'all' }] : [])]
    : recent.items.map((item) => ({ kind: 'recent' as const, id: `recent-${item}`, text: item }));
  const current = Math.min(activeFor.text === text ? activeFor.index : 0, Math.max(options.length - 1, 0));
  const setActive = (index: number) => setActiveFor({ text, index });
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'recent') { setQuery(option.text); inputRef.current?.focus(); return; }
    recent.remember(text);
    onClose();
    if (option.kind === 'all') navigate(`/search?q=${encodeURIComponent(text)}`);
    else openResult(option.result);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(options.length, 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + options.length) % Math.max(options.length, 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (options.length) choose(options[current]);
      else if (text) { recent.remember(text); onClose(); navigate(`/search?q=${encodeURIComponent(text)}`); }
    }
  };

  const total = state.status === 'ready' ? Object.values(state.answer.counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const status = !text ? '' : state.status === 'loading' ? 'Searching…' : state.status === 'failed' ? state.message
    : state.status === 'ready' ? (shown.length ? `${total}${state.answer.countsCapped ? '+' : ''} ${total === 1 ? 'result' : 'results'}` : 'No results') : '';

  return (
    <div className="jump__in">
      <div className="jump__field">
        <Icon name="search" size={16} className="jump__icon" />
        <input ref={inputRef} className="jump__input" type="search" value={query} placeholder="Search messages, tasks, decisions, people…"
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-label="Jump to"
          aria-describedby={statusId} aria-activedescendant={options.length ? `${listId}-${current}` : undefined}
          enterKeyHint="search" autoComplete="off" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        {state.status === 'loading' ? <Spinner /> : null}
        <button type="button" className="jump__close" onClick={onClose}>{phone ? 'Cancel' : <><span className="ui-vh">Close</span><kbd aria-hidden="true">Esc</kbd></>}</button>
      </div>
      <p className="ui-vh" id={statusId} role="status">{status}</p>
      <div className="jump__body">
        {!text ? (
          recent.items.length ? (
            <div className="jump__sec">
              <div className="jump__h"><span>Recent searches</span><button type="button" className="jump__clear" onClick={() => recent.clear()}>Clear</button></div>
            </div>
          ) : <p className="jump__hint">Find a message, a material and each of its versions, a task, a rule, a result, a thought or a person. Only what you can open is searched.</p>
        ) : null}
        {options.length ? (
          <ul className="jump__list" role="listbox" id={listId} aria-label={text ? 'Results' : 'Recent searches'}>
            {options.map((option, index) => (
              <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === current}
                className={`jump__opt${option.kind === 'result' ? ' sr' : ''}${option.kind === 'all' ? ' jump__all' : ''}${index === current ? ' is-active' : ''}`}
                onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(option)}>
                {option.kind === 'result' ? <ResultBody result={option.result} />
                  : option.kind === 'recent' ? <><Icon name="search" size={14} className="jump__ric" /><span className="jump__rtext">{option.text}</span></>
                    : <><span className="jump__alltext">See all results for “{text}”</span><Icon name="chevron-right" size={14} /></>}
              </li>
            ))}
          </ul>
        ) : text && state.status === 'ready' ? (
          <p className="jump__empty">{/[\p{L}\p{N}]{2,}/u.test(text) ? <>Nothing you can open matches “{text}”. Try fewer or different words.</> : 'Type at least two letters of a word.'}</p>
        ) : state.status === 'failed' ? <p className="jump__empty" role="alert">{state.message}</p> : null}
      </div>
      <p className="jump__foot" aria-hidden="true">{options.length ? <><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span></> : null}<span><kbd>Esc</kbd> close</span></p>
    </div>
  );
}
