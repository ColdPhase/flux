import { Navigate, Outlet } from 'react-router';
import { useShellData } from '../app/data';

/**
 * A guest has no AI (F-036 AG-2): the pages that connect AI or set an agent up lead them to Settings › AI, which says so in one line,
 * whatever address they opened. The server refuses what such a page would do (#959); this keeps the page of controls from showing.
 */
export function AiNotForGuests() {
  const { workspace } = useShellData();
  return workspace?.role === 'guest' ? <Navigate to="/settings/agents" replace /> : <Outlet />;
}
