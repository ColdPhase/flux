import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router';

export interface TabItem {
  id: string;
  label: string;
  /** Route for navigation tabs. Without it the item is an in-page tab button. */
  to?: string;
  /** Navigation tabs: false keeps the tab current on nested routes (e.g. a doc under Docs). */
  end?: boolean;
  /** Quiet count after the label, e.g. open tasks. */
  count?: number;
  /** Accessible wording for the count, e.g. "3 open tasks". */
  countLabel?: string;
}

interface TabsProps {
  items: TabItem[];
  /** Selected id for in-page tabs; navigation tabs follow the current route. */
  value?: string;
  onChange?: (id: string) => void;
  label: string;
  className?: string;
  /** For in-page tabs: the id prefix of the tab panels they control. */
  panelIdPrefix?: string;
}

function Count({ item }: { item: TabItem }): ReactNode {
  // The hidden label sits in an inline wrapper, as with a visible count, so the accessible name
  // reads "Tasks, 2 open" without a space before the comma.
  if (item.count === undefined) return item.countLabel ? <span><span className="ui-vh">{item.countLabel}</span></span> : null;
  return (
    <span className="ui-tabs__count">
      <span aria-hidden="true">{item.count}</span>
      <span className="ui-vh">{item.countLabel ?? `, ${item.count}`}</span>
    </span>
  );
}

/**
 * Quiet view switcher: labels only, one short 2px accent mark that slides between tabs
 * (translate + scaleX of a 1px bar, so only transform animates).
 * Navigation tabs are links with aria-current; in-page tabs follow the ARIA tabs pattern.
 */
export function Tabs({ items, value, onChange, label, className, panelIdPrefix }: TabsProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const placedRef = useRef(false);
  const isNav = items.some((item) => item.to);

  const place = useCallback((animate: boolean) => {
    const bar = barRef.current;
    const indicator = indicatorRef.current;
    if (!bar || !indicator) return;
    const current = bar.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    if (!current) { indicator.style.opacity = '0'; return; }
    const pad = parseFloat(getComputedStyle(current).paddingLeft) || 0;
    if (!animate) indicator.style.transition = 'none';
    indicator.style.opacity = '1';
    // A short mark at the start of the current label (Studio 11.6): at most 16px wide.
    indicator.style.transform = `translateX(${current.offsetLeft + pad}px) scaleX(${Math.min(16, Math.max(1, current.offsetWidth - pad * 2))})`;
    if (!animate) { void indicator.offsetWidth; indicator.style.transition = ''; }
  }, []);

  // Re-measure after every render: the route (aria-current) or the value may have changed.
  useLayoutEffect(() => {
    place(placedRef.current);
    placedRef.current = true;
  });

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(bar);
    // Webfont swaps change label widths without resizing the bar.
    void document.fonts?.ready.then(() => place(false));
    return () => observer.disconnect();
  }, [place]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isNav) return;
    const index = items.findIndex((item) => item.id === value);
    const last = items.length - 1;
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = items[next]!;
    onChange?.(target.id);
    barRef.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus();
  };

  const indicator = <span ref={indicatorRef} className="ui-tabs__indicator" aria-hidden="true" />;

  if (isNav) {
    return (
      <nav className={['ui-tabs', className].filter(Boolean).join(' ')} aria-label={label}>
        <div ref={barRef} className="ui-tabs__bar">
          {items.map((item) => (
            <NavLink key={item.id} to={item.to ?? '.'} end={item.end ?? true} className="ui-tabs__tab" data-tab={item.id} onClick={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}>
              {item.label}<Count item={item} />
            </NavLink>
          ))}
          {indicator}
        </div>
      </nav>
    );
  }

  return (
    <div className={['ui-tabs', className].filter(Boolean).join(' ')}>
      <div ref={barRef} className="ui-tabs__bar" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="ui-tabs__tab"
              data-tab={item.id}
              id={panelIdPrefix ? `${panelIdPrefix}-tab-${item.id}` : undefined}
              aria-controls={panelIdPrefix ? `${panelIdPrefix}-${item.id}` : undefined}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange?.(item.id)}
            >
              {item.label}<Count item={item} />
            </button>
          );
        })}
        {indicator}
      </div>
    </div>
  );
}
