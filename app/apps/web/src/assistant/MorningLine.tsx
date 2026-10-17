import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../ui';
import { getMorningSummary } from './scheduleApi';
import './schedules.css';

/**
 * The morning summary the assistant wrote, as the one line under the Home greeting (F-027 AST-7 "The morning summary"). It is never an
 * Inbox item and has no second push; with nothing written today this renders nothing at all.
 */
export function MorningLine() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getMorningSummary(controller.signal).then((summary) => setLine(summary.line), () => undefined);
    return () => controller.abort();
  }, []);
  if (!line) return null;
  return <p className="home__summary" data-testid="morning-line"><Link to="/inbox">{line}<Icon name="chevron-right" size={14} /></Link></p>;
}
