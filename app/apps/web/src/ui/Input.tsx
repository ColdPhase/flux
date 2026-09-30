import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Helper text under the field. */
  hint?: ReactNode;
  /** Field error; marks the input invalid and is announced with it. */
  error?: string | null;
  /** Content aligned with the label on the right, e.g. a "Forgot password?" link. */
  labelAside?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, labelAside, id, className, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={['ui-field', error && 'ui-field--invalid', className].filter(Boolean).join(' ')}>
      <div className="ui-field__top">
        <label className="ui-field__label" htmlFor={inputId}>{label}</label>
        {labelAside}
      </div>
      <input ref={ref} id={inputId} className="ui-input" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {error ? (
        <p className="ui-field__error" id={errorId}><Icon name="alert" size={14} />{error}</p>
      ) : null}
      {hint ? <p className="ui-field__hint" id={hintId}>{hint}</p> : null}
    </div>
  );
});
