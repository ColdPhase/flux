import * as Y from 'yjs';
import type { Doc } from '@flux/contracts';
import { ApiError } from '../api/client.js';
import { updateDoc } from '../docs/api.js';
import { documentDraftGeneration, draftKey, keep, readKept } from '../docs/drafts.js';
import { AUTOSAVE } from './wiki.js';

const LOADED = Symbol('text from the server');
/** How long typing rests before it is saved as the next version. */
const IDLE_MS = 1200;
const CONFLICT = 'This page changed while you were writing. Choose “Keep my text” or “Use their version” first.';

/**
 * The page's text where live editing is off (FLUX_LIVE_EDITING=off, #239): the same editor on a Y.Text of this tab
 * only, saved as the next version once typing rests, at most once per `AUTOSAVE.spacingMs` like the shared page, and at
 * once when the page is left (#869). A save sends If-Match with the version the text started from; when someone saved
 * in between, the text is kept and the person chooses (`conflict`). Unsaved text survives a reload of this tab.
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
  /** The version someone saved while this text was written, until the person chooses. */
  conflict: Doc | null = null;
  /** Unsaved text from an earlier visit of this tab came back. */
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
    const kept = readKept(this.key);
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
    keep(this.key, { title: this.title, body: this.text.toString(), state: this.doc.state, reason: '', base: this.base, attempt: this.attempt }, this.lifetime);
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
   * Saves the text (and a new title or a restore's reason) as the next version; a refusal keeps the text here. A save
   * asked for while one runs follows it.
   */
  save(change: { title?: string; reason?: string } = {}, keepalive = false): Promise<void> {
    const explicit = change.title !== undefined || change.reason !== undefined;
    if (explicit && this.conflict) return Promise.reject(new Error(CONFLICT));
    if (this.running) return this.running.then(() => this.save(change, keepalive));
    if ((this.stopped && !keepalive) || this.conflict || (!this.dirty && !explicit)) return Promise.resolve();
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.saving = true; this.changed();
    const body = this.text.toString();
    this.running = (async () => {
      try {
        const saved = await updateDoc(this.doc.id, this.base, { body, ...(change.title ? { title: change.title } : {}), ...(change.reason ? { reason: change.reason } : {}) }, this.attempt, keepalive);
        this.base = saved.version; this.title = saved.title; this.savedAt = Date.parse(saved.createdAt); this.problem = null; this.lastSaveAt = Date.now();
        if (this.text.toString() === body) { this.dirty = false; keep(this.key, null, this.lifetime); }
        else if (!this.stopped) this.schedule();
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') this.conflict = (cause.body as { current?: Doc } | null)?.current ?? null;
        else if (cause instanceof ApiError && cause.status === 403) this.problem = 'You can read this space but not change its pages.';
        else if (cause instanceof ApiError && cause.status === 404) this.problem = 'This page is no longer available to you.';
        else { this.problem = 'Not saved yet. Your text is kept here and saves when the connection is back.'; if (!this.stopped) this.schedule(5000); }
        if (explicit) throw cause;
      } finally { this.saving = false; this.running = null; this.changed(); }
    })();
    return this.running;
  }

  /** Leaving the page saves what rests unsaved at once, also after a save still running; the request outlives the page. */
  leave() {
    if (!this.dirty || this.conflict) return this.running ?? Promise.resolve();
    return this.save({}, true);
  }

  /** The person keeps their text and saves it on top of the newer version. */
  keepMine() {
    if (!this.conflict) return;
    this.base = this.conflict.version; this.title = this.conflict.title; this.conflict = null; this.attempt = crypto.randomUUID();
    void this.save();
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
    await this.save({ title: version.title, reason: `Restored version ${version.version}` });
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
