import type { IdentityConfig } from './config.js';

/**
 * The first account comes from the setup link (#1471): `./flux up` writes `FLUX_SETUP_TOKEN` and prints `<origin>/setup#<token>` while no
 * company exists. What the API logs at start while nobody has set the company up: null once it exists or with single sign-on as the only way
 * in (the provider's first person sets it up, F-037); otherwise a line that says where the link is, or that it cannot exist. Never the token.
 */
export function setupNotice(config: Pick<IdentityConfig, 'publicOrigin' | 'setupToken' | 'ssoOnly'>, hasCompany: boolean): { level: 'info' | 'warn'; text: string } | null {
  if (hasCompany || config.ssoOnly) return null;
  if (!config.setupToken) {
    return { level: 'warn', text: 'No company exists yet and FLUX_SETUP_TOKEN is not set, so nobody can create the first account. '
      + 'Run ./flux up (it writes one), or set FLUX_SETUP_TOKEN to a random value (openssl rand -hex 32) and open '
      + `${config.publicOrigin}/setup#<that value> (docs/operations/install.md)` };
  }
  return { level: 'info', text: `No company exists yet: open the setup link that ./flux up printed (${config.publicOrigin}/setup#…) to create the owner's account` };
}
