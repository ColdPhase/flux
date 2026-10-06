import { useId } from 'react';
import { Link } from 'react-router';
import { Icon, IconButton, Sheet, type IconName, type TabItem } from '../ui';

const ICON: Record<string, IconName> = { conversation: 'chat', map: 'map', tasks: 'tasks', docs: 'doc', agents: 'spark' };

/**
 * On a phone a project's views live in its title (#318, F-025 PA-9): one tap on "Project ▾" opens them here,
 * so no bar of chips stacks under the header. Each view says what it holds; Decisions is listed when there are
 * any, and says when one waits for the reader.
 */
export function ProjectViewSheet({ open, onClose, items, current, decisions }: {
  open: boolean; onClose: () => void; items: TabItem[]; current: string | null;
  decisions: { to: string; text: string; need: boolean } | null;
}) {
  const titleId = useId();
  return (
    <Sheet open={open} onClose={onClose} labelledBy={titleId} className="pv-sheet">
      <div className="ui-panel__head pv-head">
        <h2 id={titleId} className="pv-title">Views</h2>
        <IconButton icon="x" label="Close views" onClick={onClose} />
      </div>
      <nav aria-label="Project views">
        <ul className="pv-list">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={item.to!} className="pv-item" aria-current={item.id === current ? 'page' : undefined} onClick={onClose}>
                <Icon name={ICON[item.id] ?? 'chevron-right'} size={18} className="pv-item__ic" />
                <span className="pv-item__t">{item.label}</span>
                {item.countLabel ? <span className="pv-item__n">{item.countLabel.replace(/^,\s*/, '')}</span> : null}
                {item.id === current ? <Icon name="check" size={16} className="pv-item__on" /> : null}
              </Link>
            </li>
          ))}
          {decisions ? (
            <li>
              <Link to={decisions.to} className={`pv-item${decisions.need ? ' is-need' : ''}`} onClick={onClose}>
                <Icon name="rule" size={18} className="pv-item__ic" />
                <span className="pv-item__t">Decisions</span>
                <span className="pv-item__n">{decisions.text}</span>
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
    </Sheet>
  );
}
