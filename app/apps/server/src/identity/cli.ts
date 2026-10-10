import { createDatabase } from '@flux/db';
import { IdentityAdminError, rekeyIdentity } from './admin.js';
import { loadIdentityConfig } from './config.js';

/**
 * Operator command for accounts that cannot link normally (F-024 S5b, #315). It runs in the API container:
 *   node apps/server/dist/identity/cli.js link <userId> --subject <provider sub> --reason "<why>" [--allow-sso]
 * The account is named by its Flux id; nothing is matched by email. Every run writes an audit row.
 */

function usage(): never {
  process.stderr.write('usage: identity link <userId> --subject <sub> --reason "<why>" [--allow-sso]\n');
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
  if (command !== 'link' || !userId || userId.startsWith('--')) usage();
  const subject = flag(rest, '--subject');
  const reason = flag(rest, '--reason');
  if (!subject || !reason) usage();
  const allowInSso = rest.includes('--allow-sso');
  const config = loadIdentityConfig(process.env);
  if (!config.oidc) throw new Error('No sign-on provider is configured (FLUX_OIDC_ISSUER and FLUX_OIDC_CLIENT_ID)');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDatabase(url);
  try {
    const outcome = await rekeyIdentity(db, { userId, providerId: config.oidc.providerId, subject, actor: 'operator-cli',
      reason, mode: config.ssoMode, allowInSso });
    process.stdout.write(`${outcome}: account ${userId} is linked to ${config.oidc.providerId} as subject ${subject}\n`);
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof IdentityAdminError) process.stderr.write(`refused (${error.code}): ${error.message}\n`);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
