import { Icon } from '../ui';

/**
 * New (C), always in the same place at the top of the sidebar (F-026 S3). It opens the one Create
 * window (#345); the other things that can be made are one step away inside it.
 */
export function NewMenu({ onNew, compact = false }: { onNew: () => void; compact?: boolean }) {
  return (
    <div className={`newmenu${compact ? ' newmenu--compact' : ''}`}>
      <button type="button" className="side__new" aria-haspopup="dialog" aria-keyshortcuts="C"
        aria-label={compact ? 'New' : undefined} title={compact ? 'New (C)' : undefined} onClick={onNew}>
        <Icon name="plus" size={16} />{compact ? null : <>New<kbd aria-hidden="true">C</kbd></>}
      </button>
    </div>
  );
}
