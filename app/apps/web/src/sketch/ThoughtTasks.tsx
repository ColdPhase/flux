import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { WorkItem, WorkStatus } from '@flux/contracts';
import { Icon, IconButton, MEDIA, Sheet, duration, play, trapTab, useMediaQuery } from '../ui';
import { STATUS_LABEL } from '../work/format';
import { quote } from './format';

/** Work still moving comes first, then what was finished; parked work goes last among its peers. */
const ORDER: Record<WorkStatus, number> = { in_progress: 0, blocked: 1, open: 2, done: 3, not_pursued: 4 };

/**
 * The project's tasks under each thought (UI116-4). Links are many-to-many: one task made from
 * two thoughts is listed under both, and a thought can lead to several tasks. Only links that
 * the task itself holds to a thought count, whether it was created from it or related to it.
 */
export function tasksByThought(work: WorkItem[]): Map<string, WorkItem[]> {
  const byThought = new Map<string, WorkItem[]>();
  for (const item of work) {
    const thoughts = new Set(item.links.flatMap((link) => link.from.type === 'work' && link.from.id === item.id && link.to.type === 'thought' ? [link.to.id] : []));
    for (const id of thoughts) byThought.set(id, [...(byThought.get(id) ?? []), item]);
  }
  for (const items of byThought.values()) {
    items.sort((a, b) => Number(!!a.parked) - Number(!!b.parked) || ORDER[a.status] - ORDER[b.status] || a.createdAt.localeCompare(b.createdAt));
  }
  return byThought;
}

/** The short task ID a Tasks card shows; the full ID is the link's title and target. */
export const taskId = (id: string) => id.replace(/-/g, '').slice(0, 8).toUpperCase();

export const taskHref = (projectId: string, id: string) => `/projects/${projectId}/tasks?open=work:${id}`;

const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

export interface ThoughtTasksProps {
  thought: { id: string; text: string };
  tasks: WorkItem[];
  projectId: string;
  /** `map`: "2 tasks" under the thought's text; `list`: a compact count at the end of the row. */
  variant: 'map' | 'list';
  onOpenTask(id: string): void;
}

/**
 * A thought's task count and the chooser it opens (UI116-4): every linked task with its exact ID,
 * status and people, each a link to the task in its project. A popover beside the count on larger
 * screens, a sheet on a phone. It only reads: opening and closing never select, move or scroll
 * the map, and closing returns focus to the count.
 */
export function ThoughtTasks({ thought, tasks, projectId, variant, onOpenTask }: ThoughtTasksProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const phone = useMediaQuery(MEDIA.phone);
  const titleId = useId();
  // Escape and Close return focus to the count; opening a task leaves it with the task's details.
  const refocus = useRef(false);
  const close = useCallback((returnFocus: boolean) => { refocus.current = returnFocus; setOpen(false); }, []);
  useLayoutEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    anchor.current?.focus({ preventScroll: true });
  }, [open]);

  const choose = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    // A new tab or window keeps the browser's own handling of the link.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Details remembers the count as the place to return to when it closes.
    anchor.current?.focus({ preventScroll: true });
    close(false);
    onOpenTask(id);
  };

  const body = (
    <div className="sk-tasks">
      <div className="sk-tasks__head">
        <p className="sk-tasks__k"><Icon name="tasks" size={12} />{count(tasks.length)} linked to this thought</p>
        <h2 className="sk-tasks__t" id={titleId}>{thought.text}</h2>
        <IconButton icon="x" label="Close" className="sk-tasks__close" onClick={() => close(true)} />
      </div>
      <ul className="sk-tasks__list" aria-label={`Tasks linked to ${quote(thought.text)}`}>
        {tasks.map((item) => (
          <li key={item.id}>
            <Link className="sk-task" to={taskHref(projectId, item.id)} title={`Task ${item.id}`} data-work-id={item.id} onClick={(event) => choose(event, item.id)}>
              <span className={`ws-dot ws-dot--${item.parked ? 'parked' : item.status}`} aria-hidden="true" />
              <span className="sk-task__b">
                <span className="sk-task__t">{item.title}</span>
                <span className="sk-task__m"><span className="sk-task__id">{taskId(item.id)}</span> · {STATUS_LABEL[item.status]}{item.parked ? ' · parked' : ''}</span>
                <span className="sk-task__m sk-task__people">{item.owner ? `Owner ${item.owner.name}${item.owner.kind === 'agent' ? ' (agent)' : ''}` : 'No owner yet'} · added by {item.createdBy.name}{item.createdBy.kind === 'agent' ? ' (agent)' : ''}</span>
              </span>
              <Icon name="chevron-right" size={14} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="sk-tasks__note">The same tasks as on Tasks. Opening one changes nothing on the map.</p>
    </div>
  );

  return (
    <>
      <button ref={anchor} type="button" className={`sk-work sk-work--${variant}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${count(tasks.length)} linked to ${quote(thought.text)}`}
        onClick={(event) => {
          // Some touch browsers never focus a tapped button; the chooser returns here when it closes.
          event.currentTarget.focus({ preventScroll: true });
          if (open) close(true); else setOpen(true);
        }}>
        <Icon name="tasks" size={12} />
        {/* Worded and with a chevron in the List too, so it reads as a button, not as metadata. */}
        <span>{count(tasks.length)}</span>
        <Icon name="chevron-right" size={11} />
      </button>
      {phone
        ? <Sheet open={open} onClose={() => close(true)} labelledBy={titleId} className="sk-tasks-sheet">{body}</Sheet>
        : open ? <Chooser anchor={anchor} labelledBy={titleId} onClose={close}>{body}</Chooser> : null}
    </>
  );
}

/**
 * The account menu's non-modal popover, placed beside its count in a portal so the map's zoom
 * and scroll never clip or scale it. Tab stays inside; Escape returns to the count; a click
 * elsewhere closes it and leaves focus where the person clicked.
 */
function Chooser({ anchor, labelledBy, onClose, children }: { anchor: RefObject<HTMLButtonElement | null>; labelledBy: string; onClose(returnFocus: boolean): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useLayoutEffect(() => {
    const pop = ref.current;
    // Placed beside the count, again on every resize and scroll outside the chooser.
    const place = (event?: Event) => {
      const at = anchor.current?.getBoundingClientRect();
      // Scrolling the chooser's own list keeps it where it is.
      if (!pop || !at || (event?.target instanceof Node && pop.contains(event.target))) return;
      const margin = 8;
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const below = height - at.bottom - 6 - margin;
      const above = at.top - 6 - margin;
      // The full content height, also while a smaller maximum makes the chooser scroll.
      const natural = pop.scrollHeight;
      const down = below >= Math.min(natural, 280) || below >= above;
      const room = Math.max(160, down ? below : above);
      pop.style.maxHeight = `${room}px`;
      pop.style.left = `${Math.max(margin, Math.min(at.left, width - pop.offsetWidth - margin))}px`;
      pop.style.top = `${down ? at.bottom + 6 : Math.max(margin, at.top - 6 - Math.min(natural, room))}px`;
    };
    place();
    void play(pop, [{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], duration('--dur-2'), '--ease-out', { fill: 'backwards' });
    pop?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!pop?.contains(target) && !anchor.current?.contains(target)) onCloseRef.current(false);
    };
    // Escape on the count itself closes too.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && document.activeElement === anchor.current) { event.preventDefault(); onCloseRef.current(true); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(true); return; }
    trapTab(event, ref.current);
  };
  return createPortal(
    <div ref={ref} role="dialog" aria-labelledby={labelledBy} tabIndex={-1} className="sk-tasks-pop" onKeyDown={onKeyDown}>{children}</div>,
    document.body,
  );
}
