import type { WorkStatus } from '@flux/contracts';
import { useMorph } from './motion';

/**
 * A task's state as a shape, from the final design (F-026, guide §2 "Status glyphs"): Open is an
 * outline circle, In progress a half-filled circle, Blocked a filled rounded square, Done a filled
 * circle with a check, Not pursued a slashed circle. Colour never carries the meaning, so the glyph is
 * always shown with its word: next to it (`TaskState`), or in the row or column it sits in.
 */
export function StatusGlyph({ status, size = 16, className, changeKey }: { status: WorkStatus; size?: number; className?: string; changeKey?: string }) {
  // A changed state morphs in place (#593 AC-4): the new shape settles in from a soft fade and a slightly smaller size.
  const ref = useMorph<SVGSVGElement>(status, { opacity: 0.35, transform: 'scale(.78)' }, changeKey);
  const common = { ref, width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true as const, className: `ui-glyph ui-glyph--${status}${className ? ` ${className}` : ''}` };
  switch (status) {
    case 'in_progress':
      return <svg {...common}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" /></svg>;
    case 'blocked':
      return <svg {...common}><rect x="2" y="2" width="12" height="12" rx="3.5" fill="currentColor" /><rect x="6" y="6" width="4" height="4" rx="1" className="ui-glyph__knock" /></svg>;
    case 'done':
      return <svg {...common}><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="m5 8.2 2 2 4-4.2" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="ui-glyph__knock-line" /></svg>;
    case 'not_pursued':
      return <svg {...common}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M4 12 12 4" stroke="currentColor" strokeWidth="1.5" /></svg>;
    default:
      return <svg {...common}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
  }
}

export const TASK_STATE_WORD: Record<WorkStatus, string> = {
  open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', not_pursued: 'Not pursued',
};
