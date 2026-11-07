/**
 * Whether the agents of this install may read web pages (#918, F-036 AG-8).
 *
 * Off by default, like every other outbound path of an install (link cards, GitHub, AI providers, single sign-on): a read tells the site
 * the server's address, and what an agent reads is the open web's, which can try to instruct it. The operator turns it on with
 * `FLUX_WEB_READS=on`. The test deployment's named hosts are the link cards' (`FLUX_TEST_LINK_PREVIEW_HOSTS`).
 */
export interface WebReadsConfig { enabled: boolean }

export function loadWebReadsConfig(env: NodeJS.ProcessEnv): WebReadsConfig {
  const value = env.FLUX_WEB_READS || 'off';
  if (!['on', 'off'].includes(value)) throw new Error('FLUX_WEB_READS must be on or off');
  return { enabled: value === 'on' };
}
