import { useId, useMemo, useState } from 'react';
import { webSourceLabel, webSourceList, type WebSourceItem } from '@flux/contracts';
import { Button } from '../ui';

// The sources Flux lists under an agent's web answer (F-036 AG-8, #918, #954), as a reader sees them (founder check, Hubert 2026-11-17: the
// raw addresses under four headings spilled down the message). One quiet "Sources (N)" disclosure, closed; open, what was searched for and
// each address once as its site and the last words of its path, a link, on one line. An address that was asked for and not read says why,
// short, in the same list. The same in a private answer, a shown answer, the agent's chat, a task's report and a run's end line. The stored
// text is unchanged: Copy text, notifications and what an agent reads keep the full addresses.

function SourceLine({ item, linked }: { item: WebSourceItem; linked: boolean }) {
  const label = webSourceLabel(item.address);
  const words = label ? <><span className="web-sources__site">{label.site}</span>{label.page ? <><span className="web-sources__sep"> › </span>{label.page}</> : null}</> : item.address;
  return (
    <li data-source-state={item.state}>
      {label && linked
        ? <a className="web-sources__link" href={item.address} target="_blank" rel="noopener noreferrer nofollow" title={item.address}>{words}</a>
        : <span className="web-sources__link" title={item.address}>{words}</span>}
      {item.reason ? <span className="web-sources__why">not read · {item.reason}</span> : null}
    </li>
  );
}

/** `block`: the block Flux appended to a text (from its first heading). `linked={false}` on a surface that is itself a link: no control, no link. */
export function WebSources({ block, linked = true }: { block: string; linked?: boolean }) {
  const list = useMemo(() => webSourceList(block), [block]);
  const [open, setOpen] = useState(false);
  const id = useId();
  const count = list.items.length + list.more;
  if (!count && !list.queries.length) return null;
  const summary = count ? `Sources (${count})` : `Searched the web (${list.queries.length})`;
  if (!linked) return <p className="web-sources web-sources__summary" data-web-sources="">{summary}</p>;
  return (
    <div className="web-sources" data-web-sources="">
      <Button variant="quiet" size="sm" className="web-sources__toggle" icon={open ? 'chevron-down' : 'chevron-right'} aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((value) => !value)}>{summary}</Button>
      {open ? (
        <div id={id} className="web-sources__body">
          {list.queries.length ? <p className="web-sources__searched">Searched for {list.queries.map((query) => `“${query}”`).join(', ')}</p> : null}
          {list.items.length ? <ul className="web-sources__list">{list.items.map((item) => <SourceLine key={item.address} item={item} linked={linked} />)}</ul> : null}
          {list.more ? <p className="web-sources__searched">and {list.more} more</p> : null}
        </div>
      ) : null}
    </div>
  );
}
