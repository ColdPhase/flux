import { createDatabase } from '@flux/db';
import { IdentityAdminError, rekeyIdentity, unlinkIdentity } from './admin.js';
import { loadIdentityConfig } from './config.js';

/**
 * Operator command for accounts that cannot link normally (F-024 S5b, #315). It runs in the API container:
 *   node apps/server/dist/identity/cli.js link <userId> --subject <provider sub> --reason "<why>" [--old-issuer <URL>] [--allow-sso]
 *   node apps/server/dist/identity/cli.js unlink <userId> --reason "<why>"
 * The account is named by its Flux id; nothing is matched by email. Every run writes an audit row. Removing the
 * provider sign-in is recovery only: the account owner cannot do it from Settings (F-024 S5b, #315).
 */

function usage(): never {
  process.stderr.write('usage: identity link <userId> --subject <sub> --reason "<why>" [--old-issuer <URL>] [--allow-sso]\n'
    + '       identity unlink <userId> --reason "<why>"\n');
  process.exit(2);
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage();
  return value;
}

async function main(argv: string[]) {
  const [command, userId, ...rest] = argv;
  if ((command !== 'link' && command !== 'unlink') || !userId || userId.startsWith('--')) usage();
  const reason = flag(rest, '--reason');
  if (!reason) usage();
  const config = loadIdentityConfig(process.env);
  if (!config.oidc) throw new Error('No sign-on provider is configured (FLUX_OIDC_ISSUER and FLUX_OIDC_CLIENT_ID)');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDatabase(url);
  try {
    if (command === 'unlink') {
      await unlinkIdentity(db, { userId, providerId: config.oidc.providerId, issuer: config.oidc.issuer, mode: config.ssoMode, actor: 'operator-cli', reason });
      process.stdout.write(`unlinked: account ${userId} no longer has a link to ${config.oidc.issuer}\n`);
      return;
    }
    const subject = flag(rest, '--subject');
    const oldIssuer = flag(rest, '--old-issuer');
    if (!subject) usage();
    const allowInSso = rest.includes('--allow-sso');
    const outcome = await rekeyIdentity(db, { userId, providerId: config.oidc.providerId, issuer: config.oidc.issuer, oldIssuer, subject, actor: 'operator-cli',
      reason, mode: config.ssoMode, allowInSso });
    process.stdout.write(`${outcome}: account ${userId} is linked to ${config.oidc.issuer} as subject ${subject}\n`);
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof IdentityAdminError) process.stderr.write(`refused (${error.code}): ${error.message}\n`);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
