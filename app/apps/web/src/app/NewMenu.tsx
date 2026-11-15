import { Icon } from '../ui';
import { useKeysLive } from '../ui/useKeysLive';

/**
 * New (C), always in the same place at the top of the sidebar (F-026 S3). It opens the one Create
 * window (#345); the other things that can be made are one step away inside it. Its `C` shows only while C works: in a composer or any
 * other field the key is typing (F-026 §4, persona round 27 P2 7).
 */
export function NewMenu({ onNew, compact = false }: { onNew: () => void; compact?: boolean }) {
  const live = useKeysLive();
  return (
    <div className={`newmenu${compact ? ' newmenu--compact' : ''}`}>
      <button type="button" className="side__new" aria-haspopup="dialog" aria-keyshortcuts="C"
        aria-label={compact ? 'New' : undefined} title={compact ? (live ? 'New (C)' : 'New') : undefined} onClick={onNew}>
        <Icon name="plus" size={16} />{compact ? null : <>New<kbd aria-hidden="true" style={live ? undefined : { visibility: 'hidden' }}>C</kbd></>}
      </button>
    </div>
  );
}
