import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../ui';

/**
 * New (C), always in the same place at the top of the sidebar (F-026 S3). It opens one short menu of
 * what can be created here; the full Create window (#345) replaces this menu when it lands.
 */
export function NewMenu({ open, onOpenChange, onTask, onProject, onNote, onMessage, compact = false }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  /** Null outside a project: a task belongs to one. */
  onTask: (() => void) | null; onProject: () => void; onNote: () => void; onMessage: () => void;
  compact?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const items: { label: string; icon: IconName; run: (() => void) | null; hint?: string }[] = [
    { label: 'Task', icon: 'tasks', run: onTask, hint: onTask ? undefined : 'in a project' },
    { label: 'Project', icon: 'plus', run: onProject },
    { label: 'Private note', icon: 'lock', run: onNote },
    { label: 'Message', icon: 'chat', run: onMessage },
  ];

  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, onOpenChange]);

  const close = () => { onOpenChange(false); button.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Tab') onOpenChange(false);
  };

  return (
    <div className={`newmenu${compact ? ' newmenu--compact' : ''}`}>
      <button ref={button} type="button" className="side__new" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-keyshortcuts="C" aria-label={compact ? 'New' : undefined} title={compact ? 'New (C)' : undefined} onClick={() => onOpenChange(!open)}>
        <Icon name="plus" size={16} />{compact ? null : <>New<kbd aria-hidden="true">C</kbd></>}
      </button>
      {open ? (
        <div ref={menu} id={id} className="newmenu__menu" role="menu" aria-label="New" onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className="newmenu__item" aria-disabled={item.run ? undefined : true}
              onClick={() => { if (!item.run) return; onOpenChange(false); item.run(); }}>
              <Icon name={item.icon} size={15} /><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
