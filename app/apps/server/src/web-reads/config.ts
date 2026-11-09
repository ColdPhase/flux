/**
 * Whether the agents of this install may read web pages and search the web (#918, #954, F-036 AG-8, C-29).
 *
 * On by default (founder direction, 2026-11-08): an agent reads a page with `flux_read_web` and searches with its provider's own
 * built-in search. The operator turns both off with `FLUX_WEB_READS=off`: a read tells the site the server's address, a search sends the
 * agent's query to the provider's search partner, and the open web can try to instruct an agent. The worker reads the same switch for
 * the search (`webSearchSwitch`). The test deployment's named hosts are the link cards' (`FLUX_TEST_LINK_PREVIEW_HOSTS`).
 */
export interface WebReadsConfig { enabled: boolean }

export function loadWebReadsConfig(env: NodeJS.ProcessEnv): WebReadsConfig {
  const value = env.FLUX_WEB_READS || 'on';
  if (!['on', 'off'].includes(value)) throw new Error('FLUX_WEB_READS must be on or off');
  return { enabled: value === 'on' };
}
