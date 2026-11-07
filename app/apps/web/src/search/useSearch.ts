import { useEffect, useRef, useState } from 'react';
import type { SearchResponse, SearchResult } from '@flux/contracts';
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
 * answer that arrives late is dropped, so results never mix queries or accounts.
 */
export function useSearch(query: string, limit: number): SearchState {
  const text = query.trim();
  const key = JSON.stringify([text, limit]);
  // What arrived last, and for which request; the visible state is derived from it.
  const [loaded, setLoaded] = useState<{ key: string; answer: SearchResponse } | { key: string; failed: string } | null>(null);
  const [lastAnswer, setLastAnswer] = useState<SearchResponse | null>(null);
  const latest = useRef(key);
  useEffect(() => { latest.current = key; }, [key]);

  useEffect(() => {
    if (!text) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchFlux({ q: text, limit }, controller.signal)
        .then((answer) => {
          if (latest.current !== key) return;
          setLoaded({ key, answer });
          setLastAnswer(answer);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || latest.current !== key) return;
          const message = cause instanceof ApiError && cause.status === 400 ? cause.message : 'Search is unavailable right now.';
          setLoaded({ key, failed: message });
        });
    }, DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, text, limit]);

  if (!text) return { status: 'idle' };
  if (loaded?.key === key) return 'failed' in loaded ? { status: 'failed', message: loaded.failed } : { status: 'ready', answer: loaded.answer, items: loaded.answer.items };
  return { status: 'loading', previous: lastAnswer };
}
