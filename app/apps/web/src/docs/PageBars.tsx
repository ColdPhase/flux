import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../ui';
import { DimIcon, WikiBar, WikiIcon } from './WikiParts';
import { OutlineChip } from './WikiRead';
import { useWiki } from './wiki-context';

/**
 * The edit state of the one page toolbar (#511, AC-4): Back on the left with the state, the icons in the
 * places they have in read and history (those that do not apply here dimmed, History a link), and the
 * save button far right. The private and the shared editor both use it, so editing never moves a control.
 */
export function EditBar({ back, backLabel, meta, historyTo, primary }: { back: string; backLabel: string; meta: ReactNode; historyTo: string | null; primary: ReactNode }) {
  const { compact } = useWiki();
  return (
    <WikiBar
      back={<Link className="ui-btn ui-btn--quiet wiki-bar__back" to={back}><Icon name="chevron-left" size={14} />{backLabel}</Link>}
      meta={meta}
      primary={compact ? undefined : primary}>
      {compact ? null : <>
        <OutlineChip headings={null} />
        {historyTo
          ? <Link className="ui-icon-btn" data-slot="history" to={historyTo} aria-label="History" data-tip="History"><WikiIcon name="history" /></Link>
          : <DimIcon slot="history" name="history" label="History" />}
        <DimIcon slot="share" name="share" label="Share this page" />
        <DimIcon slot="download" name="download" label="Download" />
      </>}
    </WikiBar>
  );
}
