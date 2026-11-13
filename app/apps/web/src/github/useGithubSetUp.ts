import { useEffect, useState } from 'react';
import { getGithubCapabilities } from './api';

/** What this server said about GitHub, kept for the page: a server's setup does not change while a page is open. */
let known: boolean | null = null;

/**
 * Whether this server has GitHub set up, asked once per page for a space's manager. A space shows GitHub only where it can work: a server
 * without it shows no row, no link and no "ask whoever runs Flux" (founder decision on #1419 item 4, #1424). Until the answer is in, and when
 * it cannot be read, GitHub is not shown.
 */
export function useGithubSetUp(projectId: string | undefined, wanted: boolean): boolean {
  const [answer, setAnswer] = useState<boolean | null>(known);
  useEffect(() => {
    if (!wanted || !projectId || known !== null) return undefined;
    const controller = new AbortController();
    getGithubCapabilities(projectId, controller.signal).then((capabilities) => {
      known = capabilities.status === 'configured';
      setAnswer(known);
    }, () => undefined);
    return () => controller.abort();
  }, [projectId, wanted]);
  return wanted && (known ?? answer) === true;
}
