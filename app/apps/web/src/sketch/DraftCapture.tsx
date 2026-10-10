import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { SKETCH_LIMITS } from '@flux/contracts';
import { Icon } from '../ui';
import type { DraftLine, ThoughtDraft } from './createdDraft';
import { linkOf } from './paste';
import { ThoughtImage } from './ThoughtImage';

/** Whether the draft can be saved now: every thought has text within the limit. */
export function draftReady(draft: ThoughtDraft) {
  const fits = (text: string) => !!text.trim() && text.trim().length <= SKETCH_LIMITS.text;
  return draft.lines ? draft.lines.length > 0 && draft.lines.every((line) => fits(line.text)) : fits(draft.text);
}

export function DraftCapture({ draft, parent, saving, canWrite, confirmPrevious = false, mixedParents = false, onText, onLines, onPaste, onSave, onCancel }: {
  draft: ThoughtDraft; parent: string | null; saving: boolean; canWrite: boolean;
  confirmPrevious?: boolean;
  mixedParents?: boolean;
  onText(text: string): void; onLines(lines: DraftLine[]): void;
  /** Touch devices (#252): fill this empty draft from the clipboard. */
  onPaste?(): void;
  onSave(): void; onCancel(): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  // A new draft takes focus once; later row edits or removals keep it where the person put it.
  useLayoutEffect(() => { form.current?.querySelector<HTMLElement>('textarea, input')?.focus({ preventScroll: true }); }, [draft.id]);
  const ready = canWrite && !saving && draftReady(draft);
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Unrelated shortcuts (Ctrl/⌘ K opens Jump to… while typing) keep reaching the app.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && !saving) { event.preventDefault(); onCancel(); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (ready) onSave(); }
  };
  const attempted = (draft.lines ?? [draft]).some((row) => !!row.attempt);
  const unknown = (draft.lines ?? [draft]).some((row) => row.unknown);
  const where = confirmPrevious ? (unknown ? 'Earlier draft’s saved state is unknown' : 'Earlier save from a larger screen') : mixedParents ? 'Earlier row destinations kept' : draft.parentId ? parent ? `${attempted ? 'Intended connection' : 'Connected'} to “${parent}”${attempted ? '' : ' on save'}` : 'Its parent is no longer available' : 'Top level';
  const privacy = saving ? 'saving · text kept' : attempted ? 'save not confirmed · text kept' : unknown ? 'text kept' : 'private until saved';
  const lines = draft.lines;
  if (lines) {
    const count = lines.length;
    return <form ref={form} className="sk-draft sk-draft--lines" aria-label="Pasted thoughts draft" onSubmit={(event) => { event.preventDefault(); if (ready) onSave(); }}>
      <p className="sk-draft__context">{count} new {count === 1 ? 'thought' : 'thoughts'} from a paste · {where} · {privacy}</p>
      <ol className="sk-draft__lines">
        {lines.map((line, index) => {
          const long = line.text.trim().length > SKETCH_LIMITS.text;
          const link = linkOf(line.text);
          const label = `Pasted thought ${index + 1} of ${count}`;
          return <li key={line.id} className={long || !line.text.trim() ? 'is-invalid' : undefined}>
            {link ? <Icon name="link" size={12} /> : <span className="sk-draft__n" aria-hidden="true">{index + 1}</span>}
            <input className="ui-input" aria-label={label} value={line.text} disabled={saving} aria-invalid={long || !line.text.trim()}
              aria-describedby={long ? `${line.id}-long` : undefined}
              onChange={(event) => onLines(lines.map((item) => item.id === line.id ? { ...item, text: event.target.value,
                key: item.attempt || item.unknown ? item.key : crypto.randomUUID(), editKey: crypto.randomUUID() } : item))}
              onKeyDown={keys} />
            <button type="button" className="ui-btn ui-btn--quiet sk-draft__remove" disabled={saving} aria-label={`Remove ${label.toLowerCase()}`}
              onClick={() => onLines(lines.filter((item) => item.id !== line.id))}><Icon name="x" size={12} /></button>
            {long ? <span className="sk-draft__warn" id={`${line.id}-long`}>Over {SKETCH_LIMITS.text.toLocaleString('en')} characters · shorten or remove it</span> : null}
          </li>;
        })}
      </ol>
      <div className="sk-draft__actions"><button type="submit" className="ui-btn ui-btn--primary" disabled={!ready}>{saving ? 'Saving…' : `${confirmPrevious ? 'Confirm and save' : 'Save'} ${count} ${count === 1 ? 'thought' : 'thoughts'}`}</button>
        <button type="button" className="ui-btn ui-btn--quiet" disabled={saving} onClick={onCancel}>Cancel</button>
        <span>Enter saves all · Escape cancels</span></div>
    </form>;
  }
  return <form ref={form} className="sk-draft" aria-label="New thought draft" onSubmit={(event) => { event.preventDefault(); if (ready) onSave(); }}>
    <p className="sk-draft__context">{draft.file ? 'New image' : linkOf(draft.text) ? 'New link' : 'New thought'} · {where} · {privacy}</p>
    {draft.file ? <div className="sk-draft__image"><ThoughtImage className="sk-draft__img" fileId={draft.file.id} name={draft.file.name} />
      <span>{draft.file.name} · {attempted ? 'earlier save not confirmed' : unknown ? 'earlier saved state unknown' : 'only you can see it until you save'}</span></div> : null}
    <textarea className="ui-input" rows={2} aria-label={draft.file ? 'Image caption' : 'Thought text'} value={draft.text} maxLength={SKETCH_LIMITS.text} disabled={saving}
      onChange={(event) => onText(event.target.value)} onKeyDown={keys} />
    <div className="sk-draft__actions"><button type="submit" className="ui-btn ui-btn--primary" disabled={!ready}>{saving ? 'Saving…' : `${confirmPrevious ? 'Confirm and save' : 'Save'} ${draft.file ? 'image' : 'thought'}`}</button>
      <button type="button" className="ui-btn ui-btn--quiet" disabled={saving} onClick={onCancel}>Cancel</button>
      {onPaste && !draft.file && !draft.text.trim() && !draft.attempt && !draft.unknown ? <button type="button" className="ui-btn ui-btn--quiet sk-draft__paste" disabled={saving} onClick={onPaste}>
        <Icon name="paste" size={14} />Paste lines, a link or an image</button> : null}
      <span>Enter saves · Shift+Enter adds a line · Escape cancels</span></div>
  </form>;
}
