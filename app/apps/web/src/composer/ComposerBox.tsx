import { useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref, type KeyboardEvent, type ClipboardEvent, type TextareaHTMLAttributes } from 'react';
import { Icon, publishHighestTopEdge, useToast } from '../ui';
import { AttachButton } from './Files';
import type { ComposerState } from './draft';
import { formatKey } from './formatKeys';
import { pastedFiles } from './paste';
import { useFittingHint } from './useFittingHint';

/**
 * The one composer (Spokój rule 7, #504): "+", the field and the inverted round send button, the same in the
 * conversation, a thread, a direct message, the task panel and the Sketchbook. A place gives it its own
 * placeholder, draft and send; where it cannot take files the "+" stays in its place, greyed.
 */
export function ComposerBox({ id, label, placeholder, value, onChange, onKeyDown, onSelect, onBlur, disabled, boxDisabled, maxLength, fieldRef, fieldProps,
  attach, attachDisabled, sendLabel, sendDisabled, onSend, menu }: {
  id: string; label: string; value: string;
  /** The hint in the empty field: one text, or several, longest first, of which the first that fits one line is shown. */
  placeholder: string | readonly string[];
  onChange: (value: string, caret: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect?: (caret: number) => void; onBlur?: () => void;
  /** Locks the field (a send in flight, nobody left to write to). */
  disabled?: boolean; boxDisabled?: boolean; maxLength?: number;
  fieldRef?: Ref<HTMLTextAreaElement>;
  fieldProps?: Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-describedby' | 'aria-controls' | 'aria-activedescendant'>;
  /** The place's draft, when it can take files; without it the "+" is greyed. */
  attach?: ComposerState | null; attachDisabled?: boolean;
  sendLabel: string; sendDisabled: boolean; onSend: () => void;
  /** The "@" and "/" menu, above the box. */
  menu?: ReactNode;
}) {
  const toast = useToast();
  const own = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(fieldRef, () => own.current as HTMLTextAreaElement);
  const hint = useFittingHint(own, typeof placeholder === 'string' ? [placeholder] : placeholder);
  // A toast stands above the highest composer on the screen, never on its hint (#1424).
  useLayoutEffect(() => { const box = own.current?.closest('.composer__box'); return box ? publishHighestTopEdge(box, '--ui-composer-inset') : undefined; }, []);
  // A place that measures its field's height as it is written to (an empty one is measured with the longer hint) lets the shorter hint size it again.
  useLayoutEffect(() => { const el = own.current; if (el && !el.value) el.style.height = ''; }, [hint]);
  // A pasted screenshot, picture or file attaches to the draft like the paperclip; pasted text stays text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    if (!attach) { toast({ message: 'Files cannot be added here.', timeout: 3000 }); return; }
    if (attachDisabled || attach.sending) return;
    attach.addFiles(files);
  };
  return (
    <div className="composer__box" aria-disabled={boxDisabled || undefined} onClick={(event) => { if (event.target === event.currentTarget) document.getElementById(id)?.focus(); }}>
      {attach ? <AttachButton state={attach} disabled={attachDisabled} fieldId={id} />
        : <button type="button" className="composer__attach" aria-disabled="true" aria-label="Attach files (not available here)" aria-describedby={`${id}-plus-why`} data-tip="Files cannot be added here" data-tip-align="start"
          onClick={() => toast({ message: 'Files cannot be added here.', timeout: 3000 })}><Icon name="clip" size={16} /></button>}
      {attach ? null : <span id={`${id}-plus-why`} className="ui-vh">This place takes text only.</span>}
      <label className="ui-vh" htmlFor={id}>{label}</label>
      <textarea id={id} ref={own} rows={1} value={value} maxLength={maxLength} placeholder={hint} disabled={disabled}
        onChange={(event) => onChange(event.target.value, event.target.selectionStart)} onSelect={onSelect ? (event) => onSelect(event.currentTarget.selectionStart) : undefined}
        onBlur={onBlur} onKeyDown={(event) => { if (!formatKey(event)) onKeyDown?.(event); }} onPaste={onPaste} {...fieldProps} />
      <button type="button" className="composer__send" aria-label={sendLabel} aria-disabled={sendDisabled} onClick={onSend}><Icon name="send" /></button>
      {menu}
    </div>
  );
}

/** The line under the composer that says who sees what is written: one form and one place everywhere (#504 AC-3). */
export function ComposerAudience({ id, children }: { id?: string; children: ReactNode }) {
  return <p className="composer__audience" id={id}><Icon name="lock" size={13} /><span>{children}</span></p>;
}
