import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { UNTITLED_SKETCH, type Sketch } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { createProjectSketch, listProjectSketches } from '../project/data';
import { Icon, usePop, useToast } from '../ui';
import '../docs/docs.css';

const PAGE = 50;
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * "Launch plan ▾": a space's map header is the Wiki's (#1438 point 7). The title opens the space's maps, newest change first, with "Find a
 * map", then "+ New map" and, for someone who can change this map, "Rename map" (the title opens the switcher, so rename is a row of its
 * menu). It sits in the same place with one map or fifty. It uses the Wiki's switcher styles, so both read and move the same way.
 */
export function MapSwitcher({ sketch, canWrite, onRename }: { sketch: Pick<Sketch, 'id' | 'title' | 'workspaceId'> & { projectId: string }; canWrite: boolean; onRename: () => void }) {
  const { me } = useShellData();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [maps, setMaps] = useState<Sketch[] | null>(null);
  const [creating, setCreating] = useState(false);
  // The menu is drawn where the title is, fixed to the screen: the map's header floats over the canvas inside a box that scrolls, which would clip it.
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const attempt = useRef(crypto.randomUUID());
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const pop = usePop(open);
  const id = useId();
  const close = useCallback((restore = true) => { setOpen(false); setQuery(''); if (restore) button.current?.focus(); }, []);
  // A press outside closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!surface.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, close]);
  // The maps as they are now, read when the switcher opens and when someone adds or renames one while it is open.
  const reading = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    void (async () => {
      const items: Sketch[] = [];
      for (let page = 0; ; page += 1) {
        const loaded = await listProjectSketches(sketch.workspaceId, sketch.projectId, PAGE, page * PAGE, controller.signal);
        items.push(...loaded.items);
        if (loaded.items.length === 0 || items.length >= loaded.total) break;
      }
      if (!controller.signal.aborted) setMaps(items);
    })().catch(() => undefined);
  }, [sketch.workspaceId, sketch.projectId]);
  useEffect(() => {
    if (!open) return undefined;
    findRef.current?.focus();
    read();
    return () => reading.current?.abort();
  }, [open, read]);
  useStreamEvents(me.user.id, (event) => { if (open && event.objectType === 'sketch') read(); });
  // The open map is always listed: a new one has nothing on it yet and the space's list leaves empty maps out (#508).
  const listed = useMemo(() => {
    const items = maps ?? [];
    return items.some((item) => item.id === sketch.id) ? items : [{ id: sketch.id, title: sketch.title } as Sketch, ...items];
  }, [maps, sketch.id, sketch.title]);
  const needle = fold(query.trim());
  const shown = needle ? listed.filter((item) => fold(item.title).includes(needle)) : listed;
  const href = (mapId: string) => `/projects/${sketch.projectId}/map/${mapId}`;
  async function start() {
    if (creating) return;
    setCreating(true);
    try {
      // A retry after a lost answer reuses the key, so it never makes two maps.
      const made = await createProjectSketch(sketch.workspaceId, sketch.projectId, UNTITLED_SKETCH, attempt.current);
      attempt.current = crypto.randomUUID();
      close(false);
      navigate(href(made.id), { state: { fresh: true } });
    } catch {
      toast({ message: 'The map couldn’t be created. Try again in a moment.', tone: 'danger' });
    } finally { setCreating(false); }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    const rows = [...(surface.current?.querySelectorAll<HTMLElement>('.wiki-menu__row') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); rows[(at + 1) % rows.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (at <= 0) findRef.current?.focus(); else rows[at - 1]?.focus(); }
  };
  return (
    <span className="sk-switch">
      <button ref={button} type="button" className="wiki-switch" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) { close(); return; }
          const box = button.current?.getBoundingClientRect();
          if (box) {
            const width = Math.min(340, window.innerWidth - 20);
            setAt({ top: box.bottom + 6, left: Math.max(10, Math.min(box.left - 6, window.innerWidth - width - 10)), width });
          }
          setOpen(true);
        }}>
        <span className="wiki-switch__t">{sketch.title}</span><Icon name="chevron-down" size={16} />
      </button>
      {pop.mounted ? (
        <div {...pop.props} ref={surface} id={id} className="wiki-menu wiki-switcher sk-switcher" role="dialog" aria-label="Maps in this space" onKeyDown={onKeyDown}
          style={at ? { position: 'fixed', top: at.top, left: at.left, width: at.width, right: 'auto' } : undefined}>
          <label className="wiki-find">
            <Icon name="search" size={15} />
            <input ref={findRef} type="text" placeholder="Find a map" aria-label="Find a map" autoComplete="off" value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && shown[0]) { event.preventDefault(); close(false); navigate(href(shown[0].id)); } }} />
          </label>
          <ul className="wiki-menu__list" aria-label="Maps">
            {shown.map((item) => (
              <li key={item.id}>
                <Link className="wiki-menu__row" to={href(item.id)} aria-current={item.id === sketch.id ? 'page' : undefined} title={item.title} onClick={() => close(false)}>
                  <span className="wiki-menu__t">{item.title}</span>
                  {item.id === sketch.id ? <Icon name="check" size={15} /> : null}
                </Link>
              </li>
            ))}
          </ul>
          {needle && !shown.length ? <p className="wiki-menu__empty" role="status">No map matches “{query.trim()}”.</p> : null}
          <div className="wiki-menu__sep" />
          <button type="button" className="wiki-menu__row wiki-menu__new" disabled={creating} onClick={() => void start()}><Icon name="plus" size={15} />New map</button>
          {canWrite ? <button type="button" className="wiki-menu__row wiki-menu__new" onClick={() => { close(false); onRename(); }}><Icon name="edit" size={15} />Rename map</button> : null}
        </div>
      ) : null}
    </span>
  );
}
