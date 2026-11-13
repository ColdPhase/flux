import { NotAvailable } from './NotAvailable';

/** An address nothing answers to (the router's last route): the one "not available" page (#1371). */
export function NotFoundView() {
  return <NotAvailable title="This page doesn’t exist" />;
}
