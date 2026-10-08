import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, NavLink, useNavigation } from 'react-router';
import { Icon, type IconName } from './Icon';
import { choosesInPlace } from './motion';

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
  /** `segmented`: a pill track with a raised pill behind the current tab (F-026 §4 project header). */
  variant?: 'line' | 'segmented';
}

/** A quiet tab without a visible count still names it, e.g. "Tasks, 2 open" (an exact name). */
function quietName(item: TabItem): string | undefined {
  return item.count === undefined && item.countLabel ? `${item.label}${item.countLabel}` : undefined;
}

/** The label reserves its bold width, so the current tab's heavier weight never shifts its neighbours. */
function Label({ text }: { text: string }) {
  return <span className="ui-tabs__label" data-text={text}>{text}</span>;
}

function Count({ item }: { item: TabItem }): ReactNode {
  if (item.count === undefined) return null;
  return (
    <span className="ui-tabs__count">
      <span aria-hidden="true">{item.count}</span>
      <span className="ui-vh">{item.countLabel ?? `, ${item.count}`}</span>
    </span>
  );
}

/** Whether a navigation to `path` opens this tab's route. */
function opens(item: TabItem, path: string | null): boolean {
  const to = item.to?.split(/[?#]/)[0];
  if (!path || !to?.startsWith('/')) return false;
  return path === to || (item.end === false && path.startsWith(to.endsWith('/') ? to : `${to}/`));
}

/**
 * View switcher: labels with one 2px mark under the whole current label that slides
 * between tabs (translate + scaleX of a 1px bar, so only transform animates).
 * Navigation tabs are links with aria-current; in-page tabs follow the ARIA tabs pattern.
 * Navigation feedback (#155, UI116-5): the mark slides to a chosen tab at once, while its view loads;
 * the tab becomes current (aria-current) when its content shows. A newer choice retargets the mark, and
 * a navigation that ends elsewhere returns it.
 */
export function Tabs({ items, value, onChange, label, className, panelIdPrefix, variant = 'line' }: TabsProps) {
  const segmented = variant === 'segmented';
  const barRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const placedRef = useRef(false);
  const shownRef = useRef<HTMLElement | null>(null);
  const isNav = items.some((item) => item.to);
  const navigation = useNavigation();
  const pendingPath = isNav && navigation.state !== 'idle' ? navigation.location?.pathname ?? null : null;

  const place = useCallback((animate: boolean, chosen?: HTMLElement) => {
    const bar = barRef.current;
    const indicator = indicatorRef.current;
    if (!bar || !indicator) return;
    const current = chosen ?? bar.querySelector<HTMLElement>('[data-pending]') ?? bar.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    if (!current) { indicator.style.opacity = '0'; return; }
    // When the strip scrolls sideways (five tabs at 320px), bring a newly current tab into view
    // once; later renders leave the person's own scrolling alone.
    if (shownRef.current !== current) {
      shownRef.current = current;
      const scroller = [bar, bar.parentElement].find((el): el is HTMLElement => !!el && el.scrollWidth > el.clientWidth + 1);
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const tab = current.getBoundingClientRect();
        if (tab.left < box.left) scroller.scrollLeft -= box.left - tab.left + 8;
        else if (tab.right > box.right) scroller.scrollLeft += tab.right - box.right + 8;
      }
    }
    const style = getComputedStyle(current);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    if (!animate) indicator.style.transition = 'none';
    indicator.style.opacity = '1';
    if (segmented) {
      // The raised pill covers the whole current tab and slides to the next one.
      indicator.style.transform = `translateX(${current.offsetLeft}px)`;
      indicator.style.width = `${current.offsetWidth}px`;
    } else {
      // The mark spans the whole current label (#266 PF-1), so the current place reads at a glance;
      // it slides and resizes between tabs with transform only.
      indicator.style.transform = `translateX(${current.offsetLeft + padLeft}px) scaleX(${Math.max(1, current.offsetWidth - padLeft - padRight)})`;
    }
    indicator.dataset.target = current.dataset.tab ?? '';
    if (!animate) { void indicator.offsetWidth; indicator.style.transition = ''; }
  }, [segmented]);

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
      <nav className={['ui-tabs', segmented ? 'ui-tabs--seg' : null, className].filter(Boolean).join(' ')} aria-label={label}>
        <div ref={barRef} className="ui-tabs__bar">
          {items.map((item) => (
            <NavLink key={item.id} to={item.to ?? '.'} end={item.end ?? true} className="ui-tabs__tab" data-tab={item.id} data-pending={opens(item, pendingPath) ? '' : undefined} aria-label={quietName(item)} onClick={(event) => {
                // The mark starts moving in the next frame, from the click, before the router renders the
                // pending navigation (#155); later renders keep it there or return it.
                if (choosesInPlace(event)) place(true, event.currentTarget);
                event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }}>
              <Label text={item.label} /><Count item={item} />
            </NavLink>
          ))}
          {indicator}
        </div>
      </nav>
    );
  }

  return (
    <div className={['ui-tabs', segmented ? 'ui-tabs--seg' : null, className].filter(Boolean).join(' ')}>
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
              aria-label={quietName(item)}
              id={panelIdPrefix ? `${panelIdPrefix}-tab-${item.id}` : undefined}
              aria-controls={panelIdPrefix ? `${panelIdPrefix}-${item.id}` : undefined}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange?.(item.id)}
            >
              <Label text={item.label} /><Count item={item} />
            </button>
          );
        })}
        {indicator}
      </div>
    </div>
  );
}

export interface BottomNavItem extends TabItem {
  to: string;
  icon: IconName;
  /** Whether this place is the current one; it overrides the route match for places with several pages. */
  current?: boolean;
  /** A quiet dot for something new there (its words come from `countLabel`). */
  dot?: boolean;
}

/**
 * The phone's bar of main places (#266 PF-1): each an icon over its label, at thumb height. The current
 * place carries a pill behind its icon, a strong label and aria-current; the pill grows in,
 * so the change of place is felt as well as seen. A chosen place shows the pill at once while it loads
 * (as #155 does for the tabs).
 */
export function BottomNav({ items, label, className }: { items: BottomNavItem[]; label: string; className?: string }) {
  const navigation = useNavigation();
  const pendingPath = navigation.state !== 'idle' ? navigation.location?.pathname ?? null : null;
  return (
    <nav className={['ui-bottomnav', className].filter(Boolean).join(' ')} aria-label={label}>
      {items.map((item) => {
        const content = <>
          <span className="ui-bottomnav__pill" aria-hidden="true"><Icon name={item.icon} size={20} />{item.dot ? <span className="ui-bottomnav__dot" /> : null}</span>
          <span className="ui-bottomnav__label">{item.label}</span>
        </>;
        const pending = pendingPath !== null && pendingPath === item.to ? '' : undefined;
        return item.current === undefined
          ? <NavLink key={item.id} to={item.to} end={item.end ?? true} className="ui-bottomnav__item" data-tab={item.id} data-pending={pending} aria-label={quietName(item)}>{content}</NavLink>
          : <Link key={item.id} to={item.to} className="ui-bottomnav__item" data-tab={item.id} data-pending={pending} aria-current={item.current ? 'page' : undefined} aria-label={quietName(item)}>{content}</Link>;
      })}
    </nav>
  );
}
