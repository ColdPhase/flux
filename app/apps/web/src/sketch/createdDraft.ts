import { useMemo, useState } from 'react';
import { FILE_LIMITS, SKETCH_LIMITS, type SketchDetail, type ThoughtFile } from '@flux/contracts';
import { forgetReloadRetention, setReloadRetention } from '../app/reload-retention.js';

/** One future thought of a pasted list (#252): its own thought ID, link ID, request key and spot. */
export interface DraftLine {
  id: string;
  linkId: string;
  key: string;
  text: string;
  x: number;
  y: number;
  attempt?: DraftAttempt;
}

/** The canonical creation actually dispatched, retained across an uncertain response. */
export interface DraftAttempt {
  key: string;
  parentId: string | null;
  linkId: string;
  thought: { id: string; text: string; x: number; y: number; file?: ThoughtFile; width?: number; height?: number };
}

export interface ThoughtDraft {
  id: string;
  linkId: string;
  key: string;
  parentId: string | null;
  text: string;
  x: number;
  y: number;
  /** #252: pasted lines, one future thought each, saved together. `text` is unused while they exist. */
  lines?: DraftLine[];
  /** #252: the person's own privately staged image; `text` is its caption. */
  file?: ThoughtFile;
  width?: number;
  height?: number;
  attempt?: DraftAttempt;
  /** This format records attempts; older retained drafts cannot prove an unused key. */
  tracked?: true;
}
/** A pasted row may exceed the thought limit (it is marked and blocks Save), but not without bound. */
const LINE_CHARS = 100_000;
const isUuid = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const isSpot = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

function validLines(lines: unknown): boolean {
  return Array.isArray(lines) && lines.length >= 1 && lines.length <= SKETCH_LIMITS.pasteLines && lines.every((line: Partial<DraftLine> | null) =>
    !!line && typeof line === 'object' && [line.id, line.linkId, line.key].every(isUuid)
    && typeof line.text === 'string' && line.text.length <= LINE_CHARS && isSpot(line.x) && isSpot(line.y)
    && (line.attempt === undefined || validAttempt(line.attempt, line.id)));
}

function validAttempt(value: unknown, id: unknown): boolean {
  const a = value as Partial<DraftAttempt> | null;
  const t = a?.thought;
  return !!a && typeof a === 'object' && isUuid(a.key) && isUuid(a.linkId)
    && (a.parentId === null || isUuid(a.parentId)) && !!t && t.id === id && isUuid(t.id)
    && typeof t.text === 'string' && t.text.length <= SKETCH_LIMITS.text && isSpot(t.x) && isSpot(t.y)
    && (t.file === undefined || validFile(t.file)) && (t.width === undefined || isSpot(t.width)) && (t.height === undefined || isSpot(t.height));
}

function validFile(file: unknown): boolean {
  const value = file as Partial<ThoughtFile> | null;
  return !!value && typeof value === 'object' && isUuid(value.id) && typeof value.name === 'string' && value.name.length >= 1
    && value.name.length <= FILE_LIMITS.nameChars && typeof value.size === 'number' && Number.isInteger(value.size)
    && value.size >= 1 && value.size <= FILE_LIMITS.fileBytes;
}
const PREFIX = 'flux:thought-draft:';
// This visit's newest copy of each draft. Session storage can refuse a write (quota) and keep an
// older copy, so it only supplies a draft this visit has not touched, such as after a reload.
const memory = new Map<string, ThoughtDraft | null>();
let draftGeneration = 0;
let retiredStorage = false;

function persisted(key: string): ThoughtDraft | null {
  if (retiredStorage) return null;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object') {
      const draft = value as Partial<ThoughtDraft>;
      if ([draft.id, draft.linkId, draft.key].every(isUuid)
        && (draft.parentId === null || typeof draft.parentId === 'string')
        && typeof draft.text === 'string' && draft.text.length <= SKETCH_LIMITS.text
        && isSpot(draft.x) && isSpot(draft.y)
        && (draft.lines === undefined || validLines(draft.lines))
        && (draft.file === undefined || validFile(draft.file))
        && (draft.attempt === undefined || validAttempt(draft.attempt, draft.id))
        && (draft.tracked === undefined || draft.tracked === true)
        && (draft.lines === undefined || draft.file === undefined)
        && (draft.width === undefined || isSpot(draft.width)) && (draft.height === undefined || isSpot(draft.height))) return draft as ThoughtDraft;
    }
  } catch { /* Storage may be refused; the current visit still retains its drafts. */ }
  return null;
}

/** The newest draft for this key: this visit's own copy, else one persisted before a reload. */
export function readThoughtDraft(key: string | null): ThoughtDraft | null {
  return key ? memory.has(key) ? memory.get(key) ?? null : persisted(key) : null;
}

/** Saves the draft, or clears it everywhere with `null`. A refused storage write keeps the visit's copy. */
export function writeThoughtDraft(key: string, draft: ThoughtDraft | null, generation = draftGeneration) {
  if (generation !== draftGeneration) return;
  memory.set(key, draft);
  let refused = false;
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key);
  } catch { refused = true; /* Keep the newest copy, including an empty-clear tombstone. */ }
  setReloadRetention('thought', key, key.slice(PREFIX.length).split(':')[0]!, refused, true);
}

export function forgetThoughtDrafts() {
  draftGeneration++;
  retiredStorage = true;
  memory.clear();
  forgetReloadRetention('thought');
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Refused storage never received these drafts. */ }
}

/** A reload after revocation cannot fetch the old audience. Only this person's own private text
 *  may still be recovered; no shared title or content is stored in the draft. */
export function recoverableThoughtDraftKey(personId: string, sketchId: string): string | null {
  const privateKeys = new Set(memory.keys());
  try { for (const item of Object.keys(sessionStorage)) privateKeys.add(item); } catch { /* memory fallback */ }
  return [...privateKeys].find((item) => item.startsWith(`${PREFIX}${personId}:`) && item.endsWith(`:${sketchId}`) && readThoughtDraft(item) !== null) ?? null;
}

/** One private capture for this account and actual authorized map audience. */
export function useThoughtDraft(personId: string, sketchId: string, sketch: SketchDetail | null) {
  const key = sketch ? `${PREFIX}${personId}:${sketch.workspaceId}:${sketch.scope}:${sketch.projectId ?? sketch.dmId ?? personId}:${sketch.id}` : recoverableThoughtDraftKey(personId, sketchId);
  const generation = useMemo(() => draftGeneration, [key]);
  const [loaded, setLoaded] = useState(() => ({ key, draft: readThoughtDraft(key) }));
  let current = loaded;
  if (loaded.key !== key) {
    current = { key, draft: readThoughtDraft(key) };
    setLoaded(current);
  }
  const set = (draft: ThoughtDraft | null) => {
    if (!key) return;
    if (generation !== draftGeneration) return;
    writeThoughtDraft(key, draft, generation);
    setLoaded({ key, draft });
  };
  /** The newest copy now, even from an earlier render's callback (an upload that finished later). */
  const peek = () => generation === draftGeneration ? readThoughtDraft(key) : null;
  return { draft: current.draft, set, peek };
}
