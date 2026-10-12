import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Icon, Overlay, type IconName, type TabItem } from '../ui';

// On a phone the project's title is its view menu (F-026 §4 Phone): the name with a chevron opens
// Conversation · Map · Tasks · Wiki · Agents, then "Details, goal and people". There is no chip row
// of views under the header. Used where the phone view is drawn that way (the Wiki, #354); the
// phone shell (#341) extends it to every project view.

const ICONS: Record<string, IconName> = { conversation: 'chat', map: 'map', tasks: 'tasks', docs: 'doc', agents: 'together' };

export function ProjectViewMenu({ title, views, current, onDetails }: {
  title: string; views: TabItem[]; current: string; onDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const currentRef = useRef<HTMLAnchorElement>(null);
  return (
    <>
      <h1 title={title} className="top__viewmenu-h">
        <button type="button" className="top__viewmenu" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
          onClick={() => setOpen(true)}>
          <span className="top__viewmenu-name">{title}</span><Icon name="chevron-down" size={14} />
        </button>
      </h1>
      <Overlay open={open} onClose={() => setOpen(false)} placement="center" label={`${title}, views`} id={menuId} className="viewmenu" initialFocus={currentRef}>
        <h2 className="viewmenu__t">{title}</h2>
        <nav aria-label="Project views">
          <ul className="viewmenu__list">
            {views.map((view) => {
              const here = view.id === current;
              return (
                <li key={view.id}>
                  <Link ref={here ? currentRef : undefined} to={view.to ?? '#'} className="viewmenu__item" aria-current={here ? 'page' : undefined}
                    aria-label={view.countLabel ? `${view.label}${view.countLabel}` : undefined} onClick={() => setOpen(false)}>
                    <Icon name={ICONS[view.id] ?? 'doc'} size={18} /><span className="viewmenu__l">{view.label}</span>
                    {here ? <Icon name="check" size={16} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <button type="button" className="viewmenu__item viewmenu__details" onClick={() => { setOpen(false); onDetails(); }}>
          <Icon name="panel" size={18} /><span className="viewmenu__l">Details, goal and people</span>
        </button>
      </Overlay>
    </>
  );
}
