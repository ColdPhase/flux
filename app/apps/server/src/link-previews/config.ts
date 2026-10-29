/**
 * Link cards (#469): whether the server may fetch the page behind a web address in a message to show its title and description.
 *
 * Off by default, like every other outbound path of an install (GitHub, AI providers, single sign-on): a fetch tells the site
 * the server's address, and a pasted link can itself be private. The operator turns it on with `FLUX_LINK_PREVIEWS=on`.
 */
export interface LinkPreviewsConfig {
  enabled: boolean;
  /**
   * TEST ONLY (`FLUX_TEST_LINK_PREVIEW_HOSTS=name=host:port,...`, refused unless `FLUX_TEST_FAILURE_INJECTION=true`): public-looking
   * names that connect to a mock in the test stack. Every other rule (scheme, default port, redirects, size, type) still applies,
   * and a test run is closed to the world: any other name with a dot is not even resolved, and nothing it resolves to is public.
   */
  testHosts: ReadonlyMap<string, { host: string; port: number }>;
}

export function loadLinkPreviewsConfig(env: NodeJS.ProcessEnv): LinkPreviewsConfig {
  const value = env.FLUX_LINK_PREVIEWS || 'off';
  if (!['on', 'off'].includes(value)) throw new Error('FLUX_LINK_PREVIEWS must be on or off');
  const testHosts = new Map<string, { host: string; port: number }>();
  for (const entry of (env.FLUX_TEST_LINK_PREVIEW_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = /^([a-z0-9.-]+)=([a-z0-9.-]+):(\d{1,5})$/i.exec(entry);
    if (!match) throw new Error(`FLUX_TEST_LINK_PREVIEW_HOSTS: invalid entry ${entry}`);
    testHosts.set(match[1]!.toLowerCase(), { host: match[2]!, port: Number(match[3]) });
  }
  if (testHosts.size && env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_LINK_PREVIEW_HOSTS is for test deployments only');
  return { enabled: value === 'on', testHosts };
}
