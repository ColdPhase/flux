import { useRef, type KeyboardEvent } from 'react';
import { setTheme, useTheme, type ThemeChoice } from './theme';

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match system' },
];

/**
 * The theme for this device: Light, Dark or Match system, with no accent colour (F-026). A radio
 * group with arrow-key movement, shared by the account popover and Settings, so both always show and
 * change the same choice.
 */
export function AppearanceControls({ idPrefix, sectionClass = 'me__sec' }: { idPrefix: string; sectionClass?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = THEMES.findIndex((item) => item.id === theme);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = THEMES[(index + delta + THEMES.length) % THEMES.length]!;
    setTheme(next.id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-theme-option="${next.id}"]`)?.focus());
  };
  return (
    <div ref={ref} className="appearance">
      <div className={sectionClass}>
        <span className="me__label" id={`${idPrefix}-theme`}>Appearance</span>
        <div className="seg" role="radiogroup" aria-labelledby={`${idPrefix}-theme`} onKeyDown={move}>
          {THEMES.map((item) => (
            <button key={item.id} type="button" role="radio" className="seg__b" data-theme-option={item.id}
              aria-checked={theme === item.id} tabIndex={theme === item.id ? 0 : -1} onClick={() => setTheme(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
