import { useEffect, useRef, useState } from 'react';
import type { SearchResponse, SearchResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { searchFlux } from './api';

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; previous: SearchResponse | null }
  | { status: 'ready'; answer: SearchResponse; items: SearchResult[] }
  /** `retry` asks again, for a failure that may pass (the server or the network), never for a search the server refused. */
  | { status: 'failed'; message: string; retry?: () => void };

const DEBOUNCE_MS = 140;

/**
 * Searches as the person types. Only the answer to the latest request is ever shown: an older
 * answer that arrives late is dropped, so results never mix queries or accounts.
 */
export function useSearch(query: string, limit: number): SearchState {
  const text = query.trim();
  const key = JSON.stringify([text, limit]);
  // What arrived last, and for which request; the visible state is derived from it.
  const [loaded, setLoaded] = useState<{ key: string; answer: SearchResponse } | { key: string; failed: string; again: boolean } | null>(null);
  // Try again after a failure (round 15 look-1 P3-6: Search said it couldn't answer with no way to ask again).
  const [attempt, setAttempt] = useState(0);
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
          const refused = cause instanceof ApiError && cause.status === 400;
          setLoaded({ key, failed: refused ? cause.message : 'Search is unavailable right now.', again: !refused });
        });
    }, DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, text, limit, attempt]);

  if (!text) return { status: 'idle' };
  const retry = () => { setLoaded(null); setAttempt((n) => n + 1); };
  if (loaded?.key === key) return 'failed' in loaded ? { status: 'failed', message: loaded.failed, ...(loaded.again ? { retry } : {}) } : { status: 'ready', answer: loaded.answer, items: loaded.answer.items };
  return { status: 'loading', previous: lastAnswer };
}
