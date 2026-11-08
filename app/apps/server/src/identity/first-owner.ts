import { isLoopbackOrigin, type IdentityConfig } from './config.js';

/**
 * The first account to sign up becomes the company's owner (F-037), so on a public address the first sign-up after the proxy goes live
 * owns it (#994, ASVS 4.0.3 V14.1). The warning the API logs at start while nobody has signed up: null for a local try-out, closed or
 * single sign-on sign-up (the identity provider decides who can come in) and once a company exists.
 */
export function unclaimedCompanyWarning(config: Pick<IdentityConfig, 'publicOrigin' | 'signup' | 'ssoOnly'>, hasCompany: boolean): string | null {
  if (hasCompany || config.signup === 'off' || config.ssoOnly || isLoopbackOrigin(config.publicOrigin)) return null;
  return `No company exists yet, so the first person to sign up at ${config.publicOrigin} becomes its owner. Create that account before anyone else can reach this address: `
    + 'sign up first on http://127.0.0.1:<FLUX_PORT> while FLUX_PUBLIC_ORIGIN is unset or that address, then set the public address (docs/operations/install.md, step 1)';
}
