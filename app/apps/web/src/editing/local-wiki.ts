import * as Y from 'yjs';
import type { Doc } from '@flux/contracts';
import { ApiError } from '../api/client.js';
import { updateDoc } from '../docs/api.js';
import { documentDraftGeneration, draftKey, keep, readKept } from '../docs/drafts.js';

const LOADED = Symbol('text from the server');
/** How long typing rests before it is saved as the next version. */
const IDLE_MS = 1200;

/**
 * The page's text where live editing is off (FLUX_LIVE_EDITING=off, #239): the same editor on a Y.Text of this tab
 * only, saved as the next version a moment after typing rests (#869). A save sends If-Match with the version the text
 * started from; when someone saved in between, the text is kept and the person chooses (`conflict`). Unsaved text
 * survives a reload of this tab.
 */
export class LocalWiki {
  readonly document = new Y.Doc();
  readonly text = this.document.getText('body');
  readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set(), captureTimeout: 500 });
  readonly editable = true;
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
  private timer: number | null = null;
  private attempt: string = crypto.randomUUID();
  private listeners = new Set<() => void>();
  private stopped = false;
  private readonly key: string;
  private readonly lifetime = documentDraftGeneration();

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

  private schedule(delay = IDLE_MS) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.save(); }, delay);
  }

  /** Saves the text (and a new title or a restore's reason) as the next version; a refusal keeps the text here. */
  async save(change: { title?: string; reason?: string } = {}) {
    if (this.stopped || this.conflict || (this.saving && !change.title && !change.reason)) return;
    if (!this.dirty && change.title === undefined && change.reason === undefined) return;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.saving = true; this.changed();
    const body = this.text.toString();
    try {
      const saved = await updateDoc(this.doc.id, this.base, { body, ...(change.title ? { title: change.title } : {}), ...(change.reason ? { reason: change.reason } : {}) }, this.attempt);
      this.base = saved.version; this.title = saved.title; this.savedAt = Date.parse(saved.createdAt); this.problem = null;
      if (this.text.toString() === body) { this.dirty = false; keep(this.key, null, this.lifetime); }
      else this.schedule();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') this.conflict = (cause.body as { current?: Doc } | null)?.current ?? null;
      else if (cause instanceof ApiError && cause.status === 403) this.problem = 'You can read this space but not change its pages.';
      else if (cause instanceof ApiError && cause.status === 404) this.problem = 'This page is no longer available to you.';
      else { this.problem = 'Not saved yet. Your text is kept here and saves when the connection is back.'; this.schedule(5000); }
      if (change.title || change.reason) throw cause;
    } finally { this.saving = false; this.changed(); }
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
    this.document.transact(() => { this.text.delete(0, this.text.length); this.text.insert(0, version.body); }, LOADED);
    this.dirty = true;
    await this.save({ title: version.title, reason: `Restored version ${version.version}` });
  }

  async rename(title: string) { await this.save({ title }); }

  destroy() {
    // Leaving the page saves what rests unsaved at once; the kept copy covers a refusal.
    if (this.dirty && !this.conflict && !this.saving) void this.save();
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.document.off('update', this.changedText);
    this.undo.destroy();
    this.listeners.clear();
  }
}
