import * as Y from 'yjs';
import type { Doc, DocChangeCause } from '@flux/contracts';
import { ApiError } from '../api/client.js';
import { getVersion, newestVersions, updateDoc } from '../docs/api.js';
import { documentDraftGeneration, draftKey, keep, keepLeft, readKept, takeLeft, type Kept } from '../docs/drafts.js';
import { dropSavedCopy, copyOf } from './saved-copy.js';
import { AUTOSAVE } from './wiki.js';

const LOADED = Symbol('text from the server');

/**
 * Before the editor opens on a page: a kept copy older than the page whose text a later version by this person already holds is dropped
 * (#982), so a save that succeeded as the tab closed never shows as a conflict. A copy on the page's current version, or with its text, needs no
 * look; the read is only made when the copy is older and differs.
 */
export const needsSavedLook = (doc: Doc, userId: string) => { const kept = copyOf(userId, doc); return !!kept && kept.base < doc.version && kept.body !== doc.body; };
export const settleKeptCopy = (doc: Doc, userId: string, signal?: AbortSignal) => dropSavedCopy(doc, userId,
  { newest: (id, count, aborted) => newestVersions(id, count, aborted), body: async (id, version, aborted) => (await getVersion(id, version, aborted)).body }, signal);
/** How long typing rests before it is saved as the next version. */
const IDLE_MS = 1200;
const CONFLICT = 'This page changed while you were writing. Choose “Keep my text” or “Use their version” first.';

/**
 * The page's text where live editing is off (FLUX_LIVE_EDITING=off, #239): the same editor on a Y.Text of this tab
 * only, saved as the next version once typing rests, at most once per `AUTOSAVE.spacingMs` like the shared page, and at
 * once when the page is left (#869). A save sends If-Match with the version the text started from; when someone saved
 * in between, the text is kept and the person chooses (`conflict`). Unsaved text survives a reload of this tab, and a
 * tab that closes with unsaved text leaves a copy on this device that the next visit restores (#967).
 */
export class LocalWiki {
  readonly document = new Y.Doc();
  readonly text = this.document.getText('body');
  readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set(), captureTimeout: 500 });
  readonly editable = true;
  readonly writable = true;
  readonly pendingBytes = 0;
  base: number;
  title: string;
  savedAt: number;
  saving = false;
  dirty = false;
  problem: string | null = null;
  /** The server answered 404 to a save: the page may be deleted (#941); the page asks. */
  missing = false;
  /** The version someone saved while this text was written, until the person chooses. */
  conflict: Doc | null = null;
  /** Unsaved text from earlier (this tab, or a tab that closed) came back. */
  restored = false;
  private lastSaveAt = 0;
  private timer: number | null = null;
  private attempt: string = crypto.randomUUID();
  private listeners = new Set<() => void>();
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly key: string;
  private readonly lifetime = documentDraftGeneration();
  private leaving = () => { void this.leave(); };

  constructor(private readonly doc: Doc, userId: string) {
    this.key = draftKey(userId, doc.id, doc.projectId);
    this.base = doc.version;
    this.title = doc.title;
    this.savedAt = Date.parse(doc.createdAt);
    // This tab's own copy is the newest; otherwise a closed tab's copy comes back, and this tab keeps it from now on.
    const left = takeLeft(this.key);
    const kept = readKept(this.key) ?? left;
    if (kept && kept === left) keep(this.key, left, this.lifetime);
    this.document.transact(() => this.text.insert(0, kept?.body ?? doc.body), LOADED);
    if (kept && kept.body !== doc.body) {
      this.restored = true;
      // A save whose answer was lost is tried again with its own key: one version, never two.
      if (kept.attempt) this.attempt = kept.attempt;
      this.dirty = true;
      // Text kept from an older version waits for the person; on the current one it saves as usual.
      if (kept.base !== doc.version) this.conflict = doc; else this.schedule();
    } else if (kept) keep(this.key, null, this.lifetime);
    this.document.on('update', this.changedText);
    window.addEventListener('pagehide', this.leaving);
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  refuseInput(message: string) { this.problem = message; this.changed(); }
  private changed() { for (const listener of this.listeners) listener(); }

  private changedText = (_update: Uint8Array, origin: unknown) => {
    if (origin === LOADED || this.stopped) return;
    this.dirty = true;
    this.attempt = crypto.randomUUID();
    keep(this.key, this.copy(), this.lifetime);
    this.schedule();
    this.changed();
  };

  /** Once typing rests, and no sooner than the spacing after the last version. */
  private schedule(delay = IDLE_MS) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const wait = this.lastSaveAt + AUTOSAVE.spacingMs - Date.now();
      if (wait > 0) this.schedule(wait); else void this.save();
    }, delay);
  }

  /**
   * Saves the text (and a new title or the cause of a restore) as the next version; a refusal keeps the text here. A save
   * asked for while one runs follows it.
   */
  save(change: { title?: string; cause?: DocChangeCause } = {}, keepalive = false): Promise<void> {
    const explicit = change.title !== undefined || change.cause !== undefined;
    if (explicit && this.conflict) return Promise.reject(new Error(CONFLICT));
    if (this.running) return this.running.then(() => this.save(change, keepalive));
    if ((this.stopped && !keepalive) || this.conflict || (!this.dirty && !explicit)) return Promise.resolve();
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.saving = true; this.changed();
    const body = this.text.toString();
    this.running = (async () => {
      try {
        const saved = await updateDoc(this.doc.id, this.base, { body, ...(change.title ? { title: change.title } : {}), ...(change.cause ? { cause: change.cause } : {}) }, this.attempt, keepalive);
        this.adopt(saved, body);
        if (this.dirty && !this.stopped) this.schedule();
      } catch (cause) {
        const current = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT' ? (cause.body as { current?: Doc } | null)?.current ?? null : null;
        // The newer version already holds this text (the save sent when the page was left): nothing to choose.
        if (current && current.body === this.text.toString() && !explicit) this.adopt(current, current.body);
        else if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') this.conflict = current;
        else if (cause instanceof ApiError && cause.status === 403) this.problem = 'You can read this space but not change its pages.';
        else if (cause instanceof ApiError && cause.status === 404) { this.missing = true; this.problem = 'This page is no longer available to you.'; }
        else { this.problem = 'Not saved yet. Your text is kept here and saves when the connection is back.'; if (!this.stopped) this.schedule(5000); }
        if (explicit) throw cause;
      } finally { this.saving = false; this.running = null; this.changed(); }
    })();
    return this.running;
  }

  private copy(): Kept {
    return { title: this.title, body: this.text.toString(), base: this.base, attempt: this.attempt };
  }

  /**
   * Leaving the page saves what rests unsaved at once; the request outlives the page. A closing tab never starts a save
   * that waits behind a running one (#946 review), so the text goes at once as well: on the version it started from and
   * on the version the running save makes if it reaches the server first. The server refuses a stale version and makes
   * none of an unchanged text, so the two never make two versions. In the order where every one of them is refused, the
   * copy kept on this device brings the text back on the next visit (#967); a save that holds it removes the copy.
   */
  leave() {
    if (!this.dirty) return this.running ?? Promise.resolve();
    keepLeft(this.key, this.copy(), this.lifetime);
    if (this.conflict) return this.running ?? Promise.resolve();
    if (this.running) {
      const body = this.text.toString();
      // On the version the running save makes, which may be another person's: the version says what it replaced (#967).
      const after = this.base + 1;
      for (const [base, cause] of [[this.base, undefined], [after, { kind: 'page_left', version: after } as const]] as const) {
        void updateDoc(this.doc.id, base, { body, ...(cause ? { cause } : {}) }, crypto.randomUUID(), true).then((saved) => this.adopt(saved, body), () => undefined);
      }
    }
    return this.save({}, true);
  }

  /** A version that holds `body` is saved: it becomes the base, and the text is clean if it still reads `body`. */
  private adopt(saved: Doc, body: string) {
    if (saved.version < this.base) return;
    this.base = saved.version; this.title = saved.title; this.savedAt = Date.parse(saved.createdAt); this.problem = null; this.lastSaveAt = Date.now();
    if (this.text.toString() === body) { this.dirty = false; keep(this.key, null, this.lifetime); }
  }

  /** The person keeps their text and saves it on top of the newer version; the version says whose it replaced. */
  keepMine() {
    const theirs = this.conflict;
    if (!theirs) return;
    this.base = theirs.version; this.title = theirs.title; this.conflict = null; this.attempt = crypto.randomUUID();
    // The server words it ("In place of Ada’s version 4") unless the version was this person's own. A refusal shows in the page's notice.
    void this.save({ cause: { kind: 'keep_mine', version: theirs.version } }).catch(() => undefined);
  }
  /** The person takes the newer version and drops their unsaved change. */
  takeTheirs() {
    const theirs = this.conflict;
    if (!theirs) return;
    this.conflict = null; this.base = theirs.version; this.title = theirs.title; this.dirty = false; this.savedAt = Date.parse(theirs.createdAt);
    keep(this.key, null, this.lifetime);
    this.document.transact(() => { this.text.delete(0, this.text.length); this.text.insert(0, theirs.body); }, LOADED);
    this.undo.clear();
    this.changed();
  }

  /** An earlier version becomes the page again, as the next version that says so. */
  async restore(version: { version: number; title: string; body: string }) {
    if (this.conflict) throw new Error(CONFLICT);
    this.document.transact(() => { this.text.delete(0, this.text.length); this.text.insert(0, version.body); }, LOADED);
    this.dirty = true;
    await this.save({ title: version.title, cause: { kind: 'restore', version: version.version } });
  }

  async rename(title: string) { await this.save({ title }); }

  destroy() {
    const last = this.leave();
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    window.removeEventListener('pagehide', this.leaving);
    this.document.off('update', this.changedText);
    this.listeners.clear();
    void last.finally(() => this.undo.destroy());
  }
}
