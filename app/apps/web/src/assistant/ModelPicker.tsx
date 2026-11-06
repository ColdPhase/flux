import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { assistantModelName, type AssistantModelGroup, type AssistantModelPick } from '@flux/contracts';
import { Icon, usePop } from '../ui';
import { chooseAssistantModel, modelOption, useAssistantModel } from './model';

// The model control (F-027 AST-11; Connect AI #854): one button that names the model and opens one short list grouped by
// connection, "Claude plan: Opus · Sonnet · Haiku" and "ChatGPT plan: GPT-6.1 Sol · …", on the ready card, in Settings,
// next to the ask field and on the assistant's panel. Choosing is one more tap.

interface PickerProps {
  groups: readonly AssistantModelGroup[];
  value: AssistantModelPick | null;
  onSelect: (pick: AssistantModelPick) => void;
  /** `field`: "Model: Sonnet ⌄"; `chip`: the short name beside the ask field; `action`: "Choose another model" after the vendor refused one. */
  variant: 'field' | 'chip' | 'action';
  /** Where the list opens: up from the ask bar at the bottom of the screen, otherwise down. */
  placement?: 'up' | 'down';
  disabled?: boolean;
  busy?: boolean;
}

const same = (a: AssistantModelPick | null, b: AssistantModelPick) => !!a && a.connection === b.connection && a.model === b.model;

export function ModelPicker({ groups, value, onSelect, variant, placement = 'down', disabled, busy }: PickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const pop = usePop(open, { from: placement === 'up' ? 'above' : 'below' });
  const current = value ? groups.find((group) => group.connection === value.connection)?.options.find((option) => option.id === value.model) ?? null : null;
  const name = current?.name ?? (value ? assistantModelName(value.model) : '');
  // With several connections the button says which one: "Sonnet · Claude plan".
  const group = value && groups.length > 1 ? groups.find((item) => item.connection === value.connection) : undefined;

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [open]);

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
  const shown = group ? `${name} · ${group.label}` : name;

  return (
    <span ref={root} className={`aset-model aset-model--${variant}`}>
      <button ref={button} type="button" className="aset-model__btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={variant === 'action' ? 'Choose another model' : `Model: ${shown}. Change`} disabled={disabled} aria-busy={busy || undefined} onClick={() => setOpen(!open)} data-testid="model-control">
        {variant === 'field' ? <><span className="aset-model__lab" aria-hidden="true">Model:</span>{' '}</> : null}
        <span className="aset-model__name" aria-hidden="true">{variant === 'action' ? 'Choose another model' : variant === 'chip' ? name : shown}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {pop.mounted ? (
        <div {...pop.props} id={menuId} role="menu" aria-label="Model" className={`aset-model__menu aset-model__menu--${placement}`} onKeyDown={move}>
          {groups.map((item) => (
              <div key={item.connection} role="group" aria-label={item.label} className="aset-model__group">
                <span className="aset-model__group-name" aria-hidden="true">{item.label}</span>
                {item.options.map((option) => {
                  const pick = { connection: item.connection, model: option.id };
                  const checked = same(value, pick);
                  return (
                    <button key={option.id} type="button" role="menuitemradio" aria-checked={checked} className="aset-model__item" data-model={option.id} data-connection={item.connection}
                      tabIndex={checked ? 0 : -1} onClick={() => { close(true); if (!checked) onSelect(pick); }}>
                      <span className="aset-model__tick" aria-hidden="true">{checked ? <Icon name="check" size={14} /> : null}</span>
                      <span className="aset-model__text">
                        <span className="aset-model__item-name">{option.name}</span>
                        <span className="aset-model__note">{option.note}</span>
                        {option.callsTools ? null : <span className="aset-model__note">Can answer but can&apos;t make changes</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
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
  const choose = async (pick: AssistantModelPick) => {
    setBusy(true); setError(''); setSaid('');
    try { setSaid(await chooseAssistantModel(pick)); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setSaid(''), 8000); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn\'t change the model.'); }
    finally { setBusy(false); }
  };
  const named = modelOption(choice, choice.current);
  return (
    <>
      {choice.groups.length
        ? <ModelPicker groups={choice.groups} value={choice.current} onSelect={(pick) => void choose(pick)} variant={variant} placement={placement ?? 'down'} busy={busy} />
        : <span className={`aset-model aset-model--${variant} aset-model--static`}>{variant === 'field' ? 'Model: ' : ''}{named?.name ?? (choice.current ? assistantModelName(choice.current.model) : '')}</span>}
      <span className="aset-model__said" role="status" aria-live="polite">{said}</span>
      {error ? <span className="aset-model__error" role="alert">{error}</span> : null}
    </>
  );
}
