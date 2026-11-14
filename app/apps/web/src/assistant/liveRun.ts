import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { StreamRunText } from '@flux/contracts';
import { onRunText } from '../api/stream';
import { useMediaQuery } from '../ui/motion';

// The asker's live view of their own run (#1248): the words the agent writes, as the live stream brings them, and the Flux tool it uses
// now. Kept per run for this tab only, never stored; the run's answer replaces them when it is done. A piece that comes after a missed one
// stops the growing view (`lost`): what was shown stays until the answer arrives.

export interface LiveRun {
  /** The agent's message the words belong to; a new one starts the text again. */
  turn: number;
  text: string;
  /** The Flux tool it used last, for the working line before its words. */
  step: string | null;
  lost: boolean;
}

const EMPTY: LiveRun = { turn: 0, text: '', step: null, lost: false };
const KEPT = 20;
const runs = new Map<string, LiveRun>();
const watchers = new Map<string, Set<() => void>>();
let detach: (() => void) | null = null;

function take(piece: StreamRunText) {
  const now = runs.get(piece.runId) ?? EMPTY;
  let next: LiveRun;
  if ('step' in piece) next = { ...now, step: piece.step };
  else if (piece.turn > now.turn) next = piece.at === 0 ? { turn: piece.turn, text: piece.text, step: now.step, lost: false } : { turn: piece.turn, text: '', step: now.step, lost: true };
  else if (piece.turn < now.turn || now.lost) return;
  else if (piece.at > now.text.length) next = { ...now, lost: true };
  else next = { ...now, text: now.text.slice(0, piece.at) + piece.text };
  runs.delete(piece.runId);
  runs.set(piece.runId, next);
  // Only the latest runs are kept: a tab open all day does not gather every answer.
  while (runs.size > KEPT) runs.delete(runs.keys().next().value!);
  for (const watcher of [...(watchers.get(piece.runId) ?? [])]) watcher();
}

function watch(runId: string, watcher: () => void) {
  if (!detach) detach = onRunText(take);
  let set = watchers.get(runId);
  if (!set) { set = new Set(); watchers.set(runId, set); }
  set.add(watcher);
  return () => {
    set.delete(watcher);
    if (!set.size) watchers.delete(runId);
    if (!watchers.size && detach) { detach(); detach = null; }
  };
}

/** The live view of `runId` (null: none) while the component shows it. */
export function useLiveRun(runId: string | null): LiveRun {
  const subscribe = useCallback((changed: () => void) => (runId ? watch(runId, changed) : () => undefined), [runId]);
  return useSyncExternalStore(subscribe, () => (runId ? runs.get(runId) ?? EMPTY : EMPTY), () => EMPTY);
}

/** Forgets the live view of a run whose answer has arrived. */
export function useForgetLiveRun(runId: string, done: boolean) {
  useEffect(() => { if (done) runs.delete(runId); }, [runId, done]);
}

/** A Flux cite mark (C-62): `[doc:ID]`, `[doc:ID#2]`, `[task:ID]`, `[decision:ID]`, `[message:ID]`. */
const CITE_MARK = /\s?\[(?:doc|task|decision|message):[0-9a-fA-F-]{36}(?:#\d{1,3})?\]/g;
/** The start of one at the end of the words so far: the next words may finish it. */
const CITE_MARK_BEGUN = /\s?\[(?:[a-z]{1,8}(?::[0-9a-fA-F-]{0,36}(?:#\d{0,3})?)?)?$/;

/**
 * What of the growing words a reader is shown: the `[S1]` source marks and the Flux cite marks (C-62; the answer numbers them at the end),
 * whole or begun, and a `<schedule>` or `<ask>` block, whole or begun, left out. With reduced motion only finished paragraphs show, so
 * nothing types (#1248).
 */
export function shownWords(text: string, reduced: boolean): string {
  const cut = text.search(/<(?:schedule|ask)\b|<[a-z]{0,8}$/);
  const words = (cut >= 0 ? text.slice(0, cut) : text).replace(/\s?\[S\d{1,3}\]/g, '').replace(CITE_MARK, '').replace(/\s?\[S?\d{0,3}$/, '')
    .replace(CITE_MARK_BEGUN, '');
  if (!reduced) return words.trimStart();
  const end = words.lastIndexOf('\n\n');
  return end < 0 ? '' : words.slice(0, end).trim();
}

/** Whether the system asks for less motion (it follows the setting while the page is open). */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** The working line's words for the Flux tool the agent uses now (#1248). */
export function stepWords(tool: string | null): string | null {
  if (!tool) return null;
  if (/conversation|task_discussion|changes_since|orientation/.test(tool)) return 'Reading the conversation…';
  if (/read_web/.test(tool)) return 'Reading a web page…';
  if (/search/.test(tool)) return 'Searching…';
  if (/^flux_(list|get)_work/.test(tool)) return 'Looking at the tasks…';
  if (/^flux_(list|get)_doc/.test(tool)) return 'Reading the Wiki…';
  if (/^flux_(list|get)_map/.test(tool)) return 'Looking at the map…';
  if (/^flux_(list|get)_decision/.test(tool)) return 'Looking at the decisions…';
  if (/^flux_(list|read)_material/.test(tool)) return 'Reading the files…';
  if (/^flux_(list|get)_/.test(tool)) return 'Reading…';
  return 'Making a change…';
}
