import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchFilterType, SearchResponse, SearchResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { searchFlux } from './api';

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; previous: SearchResponse | null }
  | { status: 'ready'; answer: SearchResponse; items: SearchResult[] }
  | { status: 'failed'; message: string };

const DEBOUNCE_MS = 140;

/**
 * Searches as the person types. Only the answer to the latest request is ever shown: an older
 * answer that arrives late is dropped, so results never mix queries, filters or accounts.
 */
export function useSearch(query: string, options: { type?: SearchFilterType | null; place?: string | null; limit?: number } = {}) {
  const { type = null, place = null, limit } = options;
  const [attempt, setAttempt] = useState(0);
  const text = query.trim();
  const key = JSON.stringify([text, type, place, limit ?? null, attempt]);
  // What arrived last, and for which request; the visible state is derived from it.
  const [loaded, setLoaded] = useState<{ key: string; answer: SearchResponse; items: SearchResult[] } | { key: string; failed: string } | null>(null);
  const [lastAnswer, setLastAnswer] = useState<SearchResponse | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const latest = useRef(key);
  useEffect(() => { latest.current = key; }, [key]);

  useEffect(() => {
    if (!text) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchFlux({ q: text, type, place, limit }, controller.signal)
        .then((answer) => {
          if (latest.current !== key) return;
          setLoaded({ key, answer, items: answer.items });
          setLastAnswer(answer);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || latest.current !== key) return;
          const message = cause instanceof ApiError && cause.status === 400 ? cause.message : 'Search is unavailable right now.';
          setLoaded({ key, failed: message });
        });
    }, DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, text, type, place, limit]);

  let state: SearchState;
  if (!text) state = { status: 'idle' };
  else if (loaded?.key === key) state = 'failed' in loaded ? { status: 'failed', message: loaded.failed } : { status: 'ready', answer: loaded.answer, items: loaded.items };
  else state = { status: 'loading', previous: lastAnswer };

  const loadMore = useCallback(async () => {
    if (!loaded || loaded.key !== key || 'failed' in loaded || !loaded.answer.next || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await searchFlux({ q: text, type, place, limit, cursor: loaded.answer.next });
      if (latest.current !== key) return;
      setLoaded({ key, answer: { ...loaded.answer, next: page.next }, items: [...loaded.items, ...page.items] });
    } catch {
      if (latest.current === key) setLoaded({ key, failed: 'Could not load more results.' });
    } finally { setMoreBusy(false); }
  }, [loaded, key, moreBusy, text, type, place, limit]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, loadMore, moreBusy, retry };
}
