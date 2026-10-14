import { useCallback, useLayoutEffect, useState, type MouseEventHandler } from 'react';

/** Wrap actual table nodes; attribute text in the sanitized HTML is never rewritten. */
function tableRegions(root: HTMLDivElement) {
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.dataset.docTableRegion === 'true') continue;
    const region = root.ownerDocument.createElement('div');
    region.className = 'doc-table';
    region.dataset.docTableRegion = 'true';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Table');
    region.tabIndex = 0;
    table.before(region);
    region.append(table);
  }
}

/** Both reading and editor preview receive only the server's sanitized HTML. */
export function DocProse({ html, onReady, onClick }: {
  html: string;
  onReady?: (element: HTMLDivElement | null) => void;
  onClick?: MouseEventHandler<HTMLDivElement>;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => { setElement(node); onReady?.(node); }, [onReady]);
  useLayoutEffect(() => { if (element) tableRegions(element); }, [element, html]);
  return <div className="doc-prose" ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
