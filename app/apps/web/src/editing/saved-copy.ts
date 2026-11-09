import type { Doc, DocVersionSummary } from '@flux/contracts';
import { draftKey, keep, peekLeft, readKept, type Kept } from '../docs/drafts.js';

/**
 * A copy of unsaved text that was in fact saved (#982). A tab that closes sends its text as one more version, but the answer of that
 * save is never seen, so the copy stays on the device. If someone saved after it, the next visit would find a page that differs from the
 * copy and a copy older than the page, and show a conflict with text the person already saved ("Keep my text" would put it over their
 * newer version). When a later version by the same person already holds the copy's text, the copy is dropped before the editor opens.
 */
export interface VersionReader {
  /** The newest versions of the page, newest first. */
  newest(docId: string, count: number, signal?: AbortSignal): Promise<Pick<DocVersionSummary, 'version' | 'author'>[]>;
  /** The text of one version. */
  body(docId: string, version: number, signal?: AbortSignal): Promise<string>;
}

/** How many of the newest versions are looked at, and how many of this person's among them are read in full (together, in one round). */
const LOOKED_AT = 20;
const READ_IN_FULL = 5;
/** How long the editor waits for this look before it opens with the copy kept: two round trips on a good connection. */
export const LOOK_LIMIT_MS = 3000;

/** The copy this person has for the page, from this tab or from a tab that closed. */
export const copyOf = (userId: string, doc: Pick<Doc, 'id' | 'projectId'>): Kept | null => {
  const key = draftKey(userId, doc.id, doc.projectId);
  return readKept(key) ?? peekLeft(key);
};

/**
 * Whether a copy older than the page is text a later version by `userId` already holds. A copy with the page's own text, or on the
 * page's current version, is not older: the editor handles those itself.
 */
export async function savedLater(kept: Kept, doc: Pick<Doc, 'id' | 'version' | 'body'>, userId: string, read: VersionReader, signal?: AbortSignal): Promise<boolean> {
  if (kept.body === doc.body || kept.base >= doc.version) return false;
  const newest = await read.newest(doc.id, Math.min(doc.version - kept.base, LOOKED_AT), signal);
  const mine = newest.filter((version) => version.version > kept.base && version.author.kind === 'human' && version.author.id === userId);
  const bodies = await Promise.all(mine.slice(0, READ_IN_FULL).map((version) => read.body(doc.id, version.version, signal)));
  return bodies.includes(kept.body);
}

/**
 * Drops this person's copy of the page when a later version of theirs already holds it; true when it did. A failed read, or one that
 * takes longer than `limitMs`, keeps the copy: the editor must not wait on a stalled connection to open, and a conflict shown for
 * a copy that was in fact saved is the lesser harm than text that cannot be written.
 */
export async function dropSavedCopy(doc: Pick<Doc, 'id' | 'projectId' | 'version' | 'body'>, userId: string, read: VersionReader, signal?: AbortSignal, limitMs = LOOK_LIMIT_MS): Promise<boolean> {
  const kept = copyOf(userId, doc);
  if (!kept) return false;
  const limit = new AbortController();
  const stop = () => limit.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, limitMs);
  try {
    if (!await savedLater(kept, doc, userId, read, limit.signal) || limit.signal.aborted) return false;
  } catch { return false; } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  keep(draftKey(userId, doc.id, doc.projectId), null);
  return true;
}
