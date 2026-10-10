import { useMemo, useState } from 'react';
import { FILE_LIMITS, SKETCH_LIMITS, type SketchDetail, type ThoughtFile } from '@flux/contracts';
import { forgetReloadRetention, setReloadRetention } from '../app/reload-retention.js';

/** One future thought of a pasted list (#252): its own thought ID, link ID, request key and spot. */
export interface DraftLine {
  id: string;
  linkId: string;
  key: string;
  editKey?: string;
  text: string;
  x: number;
  y: number;
  attempt?: DraftAttempt;
  /** Restored without canonical metadata or a valid unused proof. Never inferred unused. */
  unknown?: true;
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
  editKey?: string;
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
  /** Lifecycle is known in this visit; restoration checks canonical metadata/proof rather than trusting this flag. */
  tracked?: true;
  unknown?: true;
}
/** A pasted row may exceed the thought limit (it is marked and blocks Save), but not without bound. */
const LINE_CHARS = 100_000;
const isUuid = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const isSpot = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

function validLines(lines: unknown): boolean {
  return Array.isArray(lines) && lines.length >= 1 && lines.length <= SKETCH_LIMITS.pasteLines && lines.every((line: Partial<DraftLine> | null) =>
    !!line && typeof line === 'object' && [line.id, line.linkId, line.key].every(isUuid)
    && typeof line.text === 'string' && line.text.length <= LINE_CHARS && isSpot(line.x) && isSpot(line.y)
    && (line.editKey === undefined || isUuid(line.editKey))
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
const UNUSED = 'flux:thought-unused:';
const unusedKey = (key: string, id: string) => `${UNUSED}${key.slice(PREFIX.length)}:${id}`;
// Fresh IDs whose proof never existed may save in memory even with blocked storage.
// A proof loaded or issued in this visit must instead be retired before dispatch.
const potentiallyUnused = new Set<string>();
const hasUnusedProof = (key: string, row: DraftLine | ThoughtDraft) => {
  try {
    const proof = unusedKey(key, row.id);
    const value = sessionStorage.getItem(proof);
    if (value !== null) potentiallyUnused.add(proof);
    return value === row.key;
  } catch { return false; }
};
const rows = (draft: ThoughtDraft) => draft.lines ?? [draft];
const canonical = (attempt: DraftAttempt) => JSON.stringify({ key: attempt.key, parentId: attempt.parentId, linkId: attempt.linkId,
  id: attempt.thought.id, text: attempt.thought.text, x: attempt.thought.x, y: attempt.thought.y,
  width: attempt.thought.width, height: attempt.thought.height, fileId: attempt.thought.file?.id });
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
        && (draft.editKey === undefined || isUuid(draft.editKey))
        && isSpot(draft.x) && isSpot(draft.y)
        && (draft.lines === undefined || validLines(draft.lines))
        && (draft.file === undefined || validFile(draft.file))
        && (draft.attempt === undefined || validAttempt(draft.attempt, draft.id))
        && (draft.tracked === undefined || draft.tracked === true)
        && (draft.lines === undefined || draft.file === undefined)
        && (draft.width === undefined || isSpot(draft.width)) && (draft.height === undefined || isSpot(draft.height))) {
        const restore = <T extends DraftLine | ThoughtDraft>(row: T): T => {
          if (row.attempt) potentiallyUnused.delete(unusedKey(key, row.id));
          return { ...row, unknown: row.attempt || hasUnusedProof(key, row) ? undefined : true };
        };
        return draft.lines ? { ...draft, tracked: true, lines: draft.lines.map(restore) } as ThoughtDraft
          : { ...restore(draft as ThoughtDraft), tracked: true };
      }
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
    if (draft) {
      sessionStorage.setItem(key, JSON.stringify(draft));
      for (const row of rows(draft)) if (row.attempt && validAttempt(row.attempt, row.id)) potentiallyUnused.delete(unusedKey(key, row.id));
      // Never issue unused authorization for an unknown restore or an earlier attempt.
      for (const row of rows(draft)) if (!row.attempt && !row.unknown && draft.tracked) {
        const proof = unusedKey(key, row.id);
        sessionStorage.setItem(proof, row.key);
        potentiallyUnused.add(proof);
      }
    } else {
      sessionStorage.removeItem(key);
      for (const item of Object.keys(sessionStorage)) if (item.startsWith(`${UNUSED}${key.slice(PREFIX.length)}:`)) sessionStorage.removeItem(item);
    }
  } catch { refused = true; /* Keep the newest copy, including an empty-clear tombstone. */ }
  setReloadRetention('thought', key, key.slice(PREFIX.length).split(':')[0]!, refused, true);
}

export function forgetThoughtDrafts() {
  draftGeneration++;
  retiredStorage = true;
  memory.clear();
  potentiallyUnused.clear();
  forgetReloadRetention('thought');
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX) || key.startsWith(UNUSED)) sessionStorage.removeItem(key);
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
  /** Before dispatch, make any older unused authorization unusable even if the full write is refused. */
  const prepareAttempt = (attempt: DraftAttempt): boolean => {
    const before = peek();
    if (!key || !before) return false;
    const row = rows(before).find((item) => item.id === attempt.thought.id);
    if (!row || row.unknown) return false;
    const proof = unusedKey(key, row.id);
    let invalidated = !potentiallyUnused.has(proof);
    try {
      sessionStorage.removeItem(proof);
      invalidated = sessionStorage.getItem(proof) === null;
      if (invalidated) potentiallyUnused.delete(proof); else potentiallyUnused.add(proof);
    } catch { /* Canonical persistence below can still make an older unused proof irrelevant. */ }
    set(before.lines ? { ...before, lines: before.lines.map((item) => item.id === row.id ? { ...item, attempt: item.attempt ?? attempt } : item) }
      : { ...before, attempt: before.attempt ?? attempt });
    const stored = persisted(key);
    const kept = stored && rows(stored).find((item) => item.id === row.id)?.attempt;
    if (invalidated || !potentiallyUnused.has(proof) || (kept && canonical(kept) === canonical(attempt))) return true;
    // No request has been dispatched. Keep the known unused retry, including its private text.
    set(before);
    return false;
  };
  return { draft: current.draft, set, peek, prepareAttempt };
}
