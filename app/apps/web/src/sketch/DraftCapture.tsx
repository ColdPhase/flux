import { useLayoutEffect, useRef } from 'react';
import { SKETCH_LIMITS } from '@flux/contracts';
import type { ThoughtDraft } from './createdDraft';

export function DraftCapture({ draft, parent, saving, canWrite, onText, onSave, onCancel }: {
  draft: ThoughtDraft; parent: string | null; saving: boolean; canWrite: boolean;
  onText(text: string): void; onSave(): void; onCancel(): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, [draft.id]);
  return <form className="sk-draft" aria-label="New thought draft" onSubmit={(event) => { event.preventDefault(); if (!saving && canWrite && draft.text.trim()) onSave(); }}>
    <p className="sk-draft__context">New thought · {draft.parentId ? parent ? `Connected to “${parent}” on save` : 'Its parent is no longer available' : 'Top level'} · private until saved</p>
    <textarea ref={input} className="ui-input" rows={2} aria-label="Thought text" value={draft.text} maxLength={SKETCH_LIMITS.text} disabled={saving}
      onChange={(event) => onText(event.target.value)} onKeyDown={(event) => {
        // Unrelated shortcuts (Ctrl/⌘ K opens Jump to… while typing) keep reaching the app.
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && !saving) { event.preventDefault(); onCancel(); }
        else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!saving && canWrite && draft.text.trim()) onSave(); }
      }} />
    <div className="sk-draft__actions"><button type="submit" className="ui-btn ui-btn--primary" disabled={saving || !canWrite || !draft.text.trim()}>{saving ? 'Saving…' : 'Save thought'}</button>
      <button type="button" className="ui-btn ui-btn--quiet" disabled={saving} onClick={onCancel}>Cancel</button>
      <span>Enter saves · Shift+Enter adds a line · Escape cancels</span></div>
  </form>;
}
