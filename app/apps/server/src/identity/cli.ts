import { createDatabase, passwordResetLinks } from '@flux/db';
import { makeResetLink } from './reset-links.js';
import { IdentityAdminError, rekeyIdentity, unlinkIdentity } from './admin.js';
import { loadIdentityConfig } from './config.js';

/**
 * Operator command for accounts that cannot link normally (F-024 S5b, #315). It runs in the API container:
 *   node apps/server/dist/identity/cli.js link <userId> --subject <provider sub> --reason "<why>" [--old-issuer <URL>] [--allow-sso]
 *   node apps/server/dist/identity/cli.js unlink <userId> --reason "<why>"
 * The account is named by its Flux id; nothing is matched by email. Every run writes an audit row. Removing the
 * provider sign-in is recovery only: the account owner cannot do it from Settings (F-024 S5b, #315).
 *
 *   node apps/server/dist/identity/cli.js reset-link <email>
 * prints a one-time password reset link for the account with that address, the owner's too (#1471; `./flux reset-link <email>`). The
 * link is recorded as made by the server command; it is printed here only and never logged.
 */

function usage(): never {
  process.stderr.write('usage: identity link <userId> --subject <sub> --reason "<why>" [--old-issuer <URL>] [--allow-sso]\n'
    + '       identity unlink <userId> --reason "<why>"\n'
    + '       identity reset-link <email>\n');
  process.exit(2);
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage();
  return value;
}

async function resetLink(email: string | undefined) {
  if (!email || email.startsWith('--')) usage();
  const config = loadIdentityConfig(process.env);
  if (config.ssoOnly) throw new Error('With single sign-on as the only way in, passwords are the identity provider’s: there is no reset link');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDatabase(url);
  try {
    const account = await passwordResetLinks(db).byEmail(email);
    if (!account) throw new Error(`No Flux account has the address ${email}`);
    if (!account.hasPassword) throw new Error(`${email} signs in without a password (single sign-on), so it has no password to reset`);
    const made = await makeResetLink(db, { publicOrigin: config.publicOrigin, ttlSeconds: config.passwordResetTtlSeconds, userId: account.userId, via: 'command', madeBy: null });
    const minutes = Math.round(config.passwordResetTtlSeconds / 60);
    process.stdout.write(`Reset link for ${email} (it works once, for ${minutes} minutes; an older link stops working):\n\n  ${made.link}\n\n`);
  } finally {
    await pool.end();
  }
}

async function main(argv: string[]) {
  if (argv[0] === 'reset-link') return resetLink(argv[1]);
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
