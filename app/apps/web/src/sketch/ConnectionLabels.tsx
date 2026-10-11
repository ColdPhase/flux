import { useLayoutEffect, useRef, useState } from 'react';
import { SKETCH_LIMITS, type SketchDetail, type ThoughtLink } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, IconButton, Input, Overlay } from '../ui';
import './connection-labels.css';

export type ConnectionTarget = { thoughtId: string } | { linkId: string };
export type SaveLinkLabel = (id: string, label: string | null, expectedLabel: string | null, key: string) => Promise<ThoughtLink>;

/** One small surface for discovering a thought's connections and naming any one of them. */
export function ConnectionLabels({ sketch, target, editable, onSave, onClose }: {
  sketch: SketchDetail; target: ConnectionTarget; editable: boolean; onSave: SaveLinkLabel; onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const initial = 'linkId' in target ? sketch.links.find((link) => link.id === target.linkId) : null;
  const [editing, setEditing] = useState(() => initial ? { id: initial.id, expected: initial.label, text: initial.label ?? '' } : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ label: string | null } | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const selected = 'thoughtId' in target ? sketch.thoughts.find((thought) => thought.id === target.thoughtId) : null;
  const links = selected ? sketch.links.filter((link) => link.fromId === selected.id || link.toId === selected.id) : [];
  const link = editing ? sketch.links.find((item) => item.id === editing.id) : null;
  const title = (id: string) => sketch.thoughts.find((thought) => thought.id === id)?.text ?? 'Thought no longer available';
  const editingId = editing?.id;
  useLayoutEffect(() => { if (editingId) input.current?.focus(); }, [editingId]);

  const close = () => { if (!inFlight.current) onClose(); };
  const save = async (reviewed = false) => {
    if (!editing || !link || !editable || inFlight.current || (conflict && !reviewed)) return;
    const expected = reviewed && conflict ? conflict.label : editing.expected;
    const label = editing.text.trim() || null;
    const signature = JSON.stringify([editing.id, label, expected]);
    // Keep the same key after an unknown network result, including an explicitly reviewed conflict.
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const { key } = attempt.current;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(editing.id, label, expected, key);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'LABEL_CONFLICT') {
        const body = cause.body as { currentLabel?: string | null; current?: ThoughtLink };
        setConflict({ label: body.current?.label ?? body.currentLabel ?? null });
        setError('Someone else changed this label. Review the saved label before replacing it.');
      } else {
        setError(cause instanceof ApiError && (cause.status === 403 || cause.status === 404)
          ? 'This connection is no longer available to edit. Your text is kept below.'
          : 'The label could not be saved. Your text is kept; try again when connected.');
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return <Overlay open placement="center" label={editing ? 'Connection label' : 'Connections'} onClose={close}
    initialFocus={editing ? input : undefined} className="connection-labels">
    <header className="ui-panel__head">
      <h2>{editing ? 'Connection label' : 'Connections'}</h2>
      <IconButton icon="x" label="Close connections" disabled={saving} onClick={close} />
    </header>
    {editing ? <form className="connection-labels__body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {link ? <div className="connection-labels__pair"><p>{title(link.fromId)}</p><Icon name="link" size={16} /><p>{title(link.toId)}</p></div>
        : <p role="status">This connection was removed. Your unsaved text is kept below.</p>}
      <Input ref={input} label="Label" value={editing.text} maxLength={SKETCH_LIMITS.label} disabled={saving}
        placeholder="e.g. depends on" hint="Describe how these thoughts relate. Leave blank to remove only the label."
        onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
      {!editable ? <p role="status">Editing connections is available on a larger screen when you have edit access.</p> : null}
      {error ? <p className="connection-labels__error" role="alert">{error}</p> : null}
      {conflict ? <div className="connection-labels__conflict"><span>Current saved label</span><p>{conflict.label || 'No label'}</p></div> : null}
      <footer className="connection-labels__actions">
        <Button variant="secondary" disabled={saving} onClick={close}>Cancel</Button>
        {conflict ? <Button variant="primary" disabled={saving || !editable || !link} onClick={() => void save(true)}>{saving ? 'Saving…' : 'Replace with my label'}</Button>
          : <Button variant="primary" type="submit" disabled={saving || !editable || !link}>{saving ? 'Saving…' : 'Save'}</Button>}
      </footer>
    </form> : <div className="connection-labels__body">
      <p className="connection-labels__subject">{selected?.text ?? 'This thought is no longer available.'}</p>
      <p className="connection-labels__hint">Name a connection to explain how the thoughts relate.</p>
      {links.length ? <ul className="connection-labels__list">{links.map((item) => {
        const other = title(item.fromId === selected?.id ? item.toId : item.fromId);
        return <li key={item.id}><button type="button" disabled={!editable} aria-label={`${item.label ? 'Edit' : 'Add'} label for connection to ${other}`}
          onClick={() => { setError(null); setConflict(null); setEditing({ id: item.id, text: item.label ?? '', expected: item.label }); }}>
          <span><strong>{other}</strong>{item.label ? <span className="connection-labels__saved">{item.label}</span> : null}</span>
          <span className="connection-labels__action">{item.label ? 'Edit label' : 'Add label'}<Icon name="chevron-right" size={14} /></span>
        </button></li>;
      })}</ul> : <p>No connections yet. Drag this thought’s dot onto another thought to connect them.</p>}
    </div>}
  </Overlay>;
}
