import { useMemo } from 'react';
import { Navigate } from 'react-router';

/**
 * Sends the person to `to`, in place of this entry, with one line saying why (`location.state.note`, #592). The note is one object for as
 * long as it says the same thing: `<Navigate>` navigates again whenever its `state` is a new object, and a page that is being left
 * renders again while the navigation it asked for loads, so a fresh object every render started a navigation every render, each one
 * stopping the last before its reads finished: tens of thousands of reads of the person and the workspaces (#1126).
 */
export function NavigateWithNote({ to, note }: { to: string; note: string }) {
  const state = useMemo(() => ({ note }), [note]);
  return <Navigate to={to} replace state={state} />;
}
