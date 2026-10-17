import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ASSISTANT_PLAN_DEFAULT, assistantModelName, type AssistantModelOption } from '@flux/contracts';
import { Icon, usePop } from '../ui';
import { chooseAssistantModel, useAssistantModel } from './model';

// The assistant's model control (F-027 AST-11): one button that names the model and opens the same short list on the
// ready card, in Settings, next to the ask field and on the assistant's panel. Choosing is one more tap.

interface PickerProps {
  options: readonly AssistantModelOption[];
  value: string;
  onSelect: (id: string) => void;
  /** `field`: "Model: Sonnet ⌄"; `chip`: the short name beside the ask field; `action`: "Choose another model" after the vendor refused one. */
  variant: 'field' | 'chip' | 'action';
  /** Where the list opens: up from the ask bar at the bottom of the screen, otherwise down. */
  placement?: 'up' | 'down';
  disabled?: boolean;
  busy?: boolean;
}

export function ModelPicker({ options, value, onSelect, variant, placement = 'down', disabled, busy }: PickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const pop = usePop(open, { from: placement === 'up' ? 'above' : 'below' });
  const current = options.find((option) => option.id === value) ?? null;
  const name = current?.name ?? value;

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const items = root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    (items?.[Math.max(0, options.findIndex((option) => option.id === value))] ?? items?.[0])?.focus();
  }, [open, options, value]);

  const close = (focusButton: boolean) => { setOpen(false); if (focusButton) button.current?.focus(); };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (to >= 0) { event.preventDefault(); items[to]?.focus(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'Tab') close(false);
  };

  return (
    <span ref={root} className={`aset-model aset-model--${variant}`}>
      <button ref={button} type="button" className="aset-model__btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={variant === 'action' ? 'Choose another model' : `Model: ${name}. Change`} disabled={disabled} aria-busy={busy || undefined} onClick={() => setOpen(!open)} data-testid="model-control">
        {variant === 'field' ? <><span className="aset-model__lab" aria-hidden="true">Model:</span>{' '}</> : null}
        <span className="aset-model__name" aria-hidden="true">{variant === 'action' ? 'Choose another model' : name}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {pop.mounted ? (
        <div {...pop.props} id={menuId} role="menu" aria-label="Model" className={`aset-model__menu aset-model__menu--${placement}`} onKeyDown={move}>
          {options.map((option) => (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === value} className="aset-model__item" data-model={option.id}
              tabIndex={option.id === value ? 0 : -1} onClick={() => { close(true); if (option.id !== value) onSelect(option.id); }}>
              <span className="aset-model__tick" aria-hidden="true">{option.id === value ? <Icon name="check" size={14} /> : null}</span>
              <span className="aset-model__text">
                <span className="aset-model__item-name">{option.name}</span>
                <span className="aset-model__note">{option.note}</span>
                {option.callsTools ? null : <span className="aset-model__note">Can answer but can&apos;t make changes</span>}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The control for an assistant that is on: it reads and writes the one stored model, so every copy of it on the page
 * shows the same value. It confirms a change in a polite live region and says plainly when the server refused it.
 */
export function AssistantModelControl({ variant, placement }: { variant: 'field' | 'chip' | 'action'; placement?: 'up' | 'down' }) {
  const { choice } = useAssistantModel();
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!choice?.saved) return null;
  const choose = async (id: string) => {
    setBusy(true); setError(''); setSaid('');
    try { setSaid(await chooseAssistantModel(id)); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setSaid(''), 8000); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn\'t change the model.'); }
    finally { setBusy(false); }
  };
  const named = choice.options.find((option) => option.id === choice.current);
  return (
    <>
      {choice.options.length
        ? <ModelPicker options={choice.options} value={choice.current} onSelect={(id) => void choose(id)} variant={variant} placement={placement ?? 'down'} busy={busy} />
        : <span className={`aset-model aset-model--${variant} aset-model--static`}>{variant === 'field' ? 'Model: ' : ''}{named?.name ?? (choice.current === ASSISTANT_PLAN_DEFAULT ? "Your plan's default" : assistantModelName(choice.current))}</span>}
      <span className="aset-model__said" role="status" aria-live="polite">{said}</span>
      {error ? <span className="aset-model__error" role="alert">{error}</span> : null}
    </>
  );
}
