import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { formatKey } from '../composer/formatKeys';
import { Button, MEDIA, sendsOnEnter, useMediaQuery, useToast } from '../ui';
import './own-message.css';

// Edit and Delete on a person's own message (#1006, F-026 S6). They sit in the message's ⋯ menu, after Copy link; choosing one puts
// a small form where the words were: the words in a field to change, or the question before they are gone. Nothing else on the
// page moves, Escape puts everything back, and the message keeps its place in the stream.

export interface OwnMessageSource {
  /** The words now. */
  body: string;
  /** The message has files, so its words may be emptied. */
  hasFiles?: boolean;
  /** The id of the message's list item, to return focus to when the form closes. */
  focusId: string;
  /** Stores the new words and announces the stored message; rejects when it cannot. */
  save(body: string): Promise<unknown>;
  /** Deletes and announces the stored message; rejects when it cannot. */
  remove(): Promise<unknown>;
}

/** What to say when the server refuses: a change of rights since the menu was drawn says so; anything else may be tried again. */
function failure(cause: unknown, verb: string) {
  if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return 'You can no longer change this message';
  if (cause instanceof ApiError && cause.code === 'MESSAGE_REMOVED') return 'This message was deleted';
  return `Could not ${verb}. Try again.`;
}

function Editor({ body, hasFiles, onSave, onCancel }: { body: string; hasFiles: boolean; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const touch = useMediaQuery(MEDIA.touch);
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  const words = text.trim();
  const unchanged = words === body.trim();
  const save = async () => {
    if (busy) return;
    if (unchanged || (!words && !hasFiles)) { if (unchanged) onCancel(); return; }
    setBusy(true);
    try { await onSave(words); } finally { setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (formatKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    else if (sendsOnEnter(event, touch)) { event.preventDefault(); void save(); }
  };
  return (
    <form className="msg-edit" role="group" aria-label="Edit your message" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <textarea ref={field} className="msg-edit__field" aria-label="Edit message" value={text} rows={Math.min(8, Math.max(2, text.split('\n').length))} maxLength={100_000}
        onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div className="msg-edit__row">
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!words && !hasFiles}>Save</Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        {touch ? null : <span className="msg-edit__hint">Enter saves · Esc cancels</span>}
      </div>
    </form>
  );
}

function Confirm({ onDelete, onCancel }: { onDelete: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { keep.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="msg-edit msg-edit--confirm" role="group" aria-label="Delete this message" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <p className="msg-edit__ask">Delete this message? Its words leave search and notifications. Replies stay. This cannot be undone.</p>
      <div className="msg-edit__row">
        <Button variant="danger" size="sm" busy={busy} onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>Delete</Button>
        <Button ref={keep} variant="quiet" size="sm" onClick={onCancel}>Keep</Button>
      </div>
    </div>
  );
}

/**
 * Edit and Delete for one message, or nothing when the person did not write it. `onEdit` and `onDelete` go to the message's actions;
 * `slot` is what to show in place of the words while one of them is open (null otherwise). Hooks run for every message, so a queued
 * message that becomes a stored one keeps its list item; pass null for a message that is not the person's, or is already deleted.
 */
export function useOwnMessage(source: OwnMessageSource | null): { onEdit?: () => void; onDelete?: () => void; slot: ReactNode | null } {
  const toast = useToast();
  const [mode, setMode] = useState<'edit' | 'delete' | null>(null);
  const focusId = source?.focusId;
  const close = useCallback(() => {
    setMode(null);
    // The form leaves the item with focus inside it: focus returns to the message so a keyboard stays where it was.
    if (focusId) requestAnimationFrame(() => document.getElementById(focusId)?.focus({ preventScroll: true }));
  }, [focusId]);
  // A message that was deleted meanwhile (here or in another tab) has no source: nothing is shown or offered for it any more.
  if (!source) return { slot: null };
  const run = (verb: string, action: () => Promise<unknown>) => async () => {
    try { await action(); close(); } catch (cause) { toast({ message: failure(cause, verb), tone: 'danger' }); }
  };
  const slot = mode === 'edit'
    ? <Editor body={source.body} hasFiles={!!source.hasFiles} onCancel={close} onSave={(body) => run('save', () => source.save(body))()} />
    : mode === 'delete' ? <Confirm onCancel={close} onDelete={run('delete', () => source.remove())} /> : null;
  return { onEdit: () => setMode('edit'), onDelete: () => setMode('delete'), slot };
}
