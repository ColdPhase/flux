import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'link' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  icon?: IconName;
  /** Shows a spinner and keeps the button focusable but inactive. */
  busy?: boolean;
  block?: boolean;
  children?: ReactNode;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="ui-spin" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy = false, block = false, className, children, type = 'button', disabled, onClick, ...rest },
  ref,
) {
  const classes = ['ui-btn', `ui-btn--${variant}`, size === 'lg' && 'ui-btn--lg', block && 'ui-btn--block', className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : onClick}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: icon-only buttons are named for assistive technology and show it as a tooltip. */
  label: string;
  size?: number;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 16, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={['ui-icon-btn', className].filter(Boolean).join(' ')} aria-label={label} data-tip={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
});
