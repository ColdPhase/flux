import { useRef } from 'react';
import { useLocation } from 'react-router';
import { useShellData } from './data';
import { useReadingPosition } from './drafts';
import { HomeTasks } from './HomeTasks';

/** Home's Tasks: the work you own across your projects (#190 HOME-2). */
export function TasksView() {
  const ref = useRef<HTMLDivElement>(null);
  const { me } = useShellData();
  useReadingPosition(ref, me.user.id, useLocation().pathname);
  return <div className="pane-scroll" ref={ref}><div className="pane-in" data-shift><HomeTasks /></div></div>;
}
