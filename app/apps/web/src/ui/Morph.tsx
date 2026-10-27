import type { ReactNode } from 'react';
import { useMorph } from './motion';

/**
 * A word or value that changes in place (a task's state, a decision's outcome): when `value` changes it settles in
 * from a soft fade over --dur-in instead of jumping (#593 AC-4). The element keeps its box, so nothing around it moves.
 * `changeKey` names a thing the person just changed (`noteChange`): where it is drawn anew, it morphs too.
 */
export function Morph({ value, className, changeKey, children }: { value: unknown; className?: string; changeKey?: string; children: ReactNode }) {
  const ref = useMorph<HTMLSpanElement>(value, undefined, changeKey);
  return <span ref={ref} className={className}>{children}</span>;
}
