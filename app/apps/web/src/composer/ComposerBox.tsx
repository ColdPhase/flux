import { type ReactNode, type Ref, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { Icon } from '../ui';
import { AttachButton } from './Files';
import type { ComposerState } from './draft';

/**
 * The one composer (Spokój rule 7, #504): "+", the field and the inverted round send button, the same in the
 * conversation, a thread, a direct message, the task panel and the Sketchbook. A place gives it its own
 * placeholder, draft and send; where it cannot take files the "+" stays in its place, greyed.
 */
export function ComposerBox({ id, label, placeholder, value, onChange, onKeyDown, onSelect, onBlur, disabled, boxDisabled, maxLength, fieldRef, fieldProps,
  attach, attachDisabled, sendLabel, sendDisabled, onSend, menu }: {
  id: string; label: string; placeholder: string; value: string;
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
  return (
    <div className="composer__box" aria-disabled={boxDisabled || undefined} onClick={(event) => { if (event.target === event.currentTarget) document.getElementById(id)?.focus(); }}>
      {attach ? <AttachButton state={attach} disabled={attachDisabled} />
        : <button type="button" className="composer__attach" aria-disabled="true" aria-label="Attach files" data-tip="Files cannot be added here" data-tip-align="start"><Icon name="plus" size={17} /></button>}
      <label className="ui-vh" htmlFor={id}>{label}</label>
      <textarea id={id} ref={fieldRef} rows={1} value={value} maxLength={maxLength} placeholder={placeholder} disabled={disabled}
        onChange={(event) => onChange(event.target.value, event.target.selectionStart)} onSelect={onSelect ? (event) => onSelect(event.currentTarget.selectionStart) : undefined}
        onBlur={onBlur} onKeyDown={onKeyDown} {...fieldProps} />
      <button type="button" className="composer__send" aria-label={sendLabel} aria-disabled={sendDisabled} onClick={onSend}><Icon name="send" /></button>
      {menu}
    </div>
  );
}

/** The line under the composer that says who sees what is written: one form and one place everywhere (#504 AC-3). */
export function ComposerAudience({ id, children }: { id?: string; children: ReactNode }) {
  return <p className="composer__audience" id={id}><Icon name="lock" size={13} /><span>{children}</span></p>;
}
