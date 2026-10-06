import { useRef, type KeyboardEvent } from 'react';
import { Icon } from '../ui';
import { setAccent, setTheme, useAccent, useResolvedTheme, useTheme, type AccentChoice, type ThemeChoice } from './theme';

const THEMES: { id: ThemeChoice; label: string; icon: 'monitor' | 'sun' | 'moon' }[] = [
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

const ACCENTS: { id: AccentChoice; label: string }[] = [
  { id: 'mint', label: 'Mint' },
  { id: 'sky', label: 'Sky' },
  { id: 'copper', label: 'Copper' },
];

/**
 * Theme and accent choices for this device (#148): two radio groups with arrow-key movement. Shared by
 * the account popover and Settings (#266 PF-5), so both always show and change the same choice.
 */
export function AppearanceControls({ idPrefix, sectionClass = 'me__sec' }: { idPrefix: string; sectionClass?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const accent = useAccent();
  const resolvedTheme = useResolvedTheme();
  const move = <T extends { id: string },>(items: T[], current: string, event: KeyboardEvent<HTMLDivElement>, choose: (item: T) => void, attr: string, ends: boolean) => {
    const index = items.findIndex((item) => item.id === current);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta && !(ends && (event.key === 'Home' || event.key === 'End'))) return;
    event.preventDefault();
    const next = items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + delta + items.length) % items.length]!;
    choose(next);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[${attr}="${next.id}"]`)?.focus());
  };
  return (
    <div ref={ref} className="appearance">
      <div className={sectionClass}>
        <span className="me__label" id={`${idPrefix}-theme`}>Appearance</span>
        <div className="seg" role="radiogroup" aria-labelledby={`${idPrefix}-theme`} onKeyDown={(event) => move(THEMES, theme, event, (item) => setTheme(item.id), 'data-theme-option', false)}>
          {THEMES.map((item) => (
            <button key={item.id} type="button" role="radio" className="seg__b" data-theme-option={item.id}
              aria-checked={theme === item.id} tabIndex={theme === item.id ? 0 : -1} onClick={() => setTheme(item.id)}>
              <Icon name={item.icon} size={14} />{item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={sectionClass}>
        <span className="me__label" id={`${idPrefix}-accent`}>Accent</span>
        <span className="me__hint">For {resolvedTheme} appearance · remembered separately on this device</span>
        <div className="me-accent" role="radiogroup" aria-labelledby={`${idPrefix}-accent`} onKeyDown={(event) => move(ACCENTS, accent, event, (item) => setAccent(item.id), 'data-accent-option', true)}>
          {ACCENTS.map((item) => (
            <button key={item.id} type="button" role="radio" className="me-accent__option" data-accent-option={item.id}
              aria-checked={accent === item.id} tabIndex={accent === item.id ? 0 : -1} onClick={() => setAccent(item.id)}>
              <span className="me-accent__sample" aria-hidden="true" />{item.label}
              <Icon name="check" size={12} className="me-accent__check" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
