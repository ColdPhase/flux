import { pipeline } from 'node:stream/promises';
import { createDatabase, exportOperatorRows } from '@flux/db';
import { DomainError, ForbiddenError } from '@flux/core';
import { diskFileStorage } from '../files/storage.js';
import { exportUseCases } from './adapters.js';

// `./flux export <project> [--as <email>]` (issue #123) runs this inside the API container. It
// writes the `.tar.gz` bundle to stdout and messages to stderr. The export runs through the same
// core use case as `GET /api/v1/projects/:id/export`, as the named account (default: the
// workspace's first owner), so the access policy still decides whether it may manage the project.

function fail(message: string, code = 1): never {
  process.stderr.write(`flux export: ${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let project: string | undefined;
let as: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === '--as') as = args[++index] ?? fail('--as needs an e-mail address', 2);
  else if (!project && !arg.startsWith('-')) project = arg;
  else fail(`unknown argument ${arg}`, 2);
}
if (!project) fail('usage: flux export <project id or exact name> [--as <email>]', 2);
const connectionString = process.env.DATABASE_URL ?? fail('DATABASE_URL is required');

const { pool, db } = createDatabase(connectionString);
try {
  const operator = exportOperatorRows(db);
  const matches = await operator.findProjects(project);
  if (!matches.length) fail(`no project has the id or name "${project}"`);
  if (matches.length > 1) fail(`several projects are named "${project}"; pass the id instead: ${matches.map((match) => match.id).join(', ')}`);
  const target = matches[0]!;
  const userId = as ? await operator.findUserByEmail(as) : await operator.workspaceOwner(target.workspaceId);
  if (!userId) fail(as ? `no account has the e-mail address ${as}` : 'the project workspace has no owner; pass --as <email>');
  const storage = await diskFileStorage(process.env.FLUX_FILES_DIR ?? '/data/files');
  const bundle = await exportUseCases(db, process.env.FLUX_PUBLIC_ORIGIN ?? null, storage).exportBundle({ kind: 'human', id: userId }, target.id);
  process.stderr.write(`Exported "${bundle.data.project.name}" (${target.id}) as ${bundle.data.provenance.exportedBy.name}: `
    + `${bundle.data.conversations.length} conversations, ${bundle.data.docs.length} docs, ${bundle.data.sketches.length} sketches, `
    + `${bundle.data.work.length} work items, ${bundle.data.decisions.length} decisions, ${bundle.data.results.length} results.\n`);
  process.stderr.write(`FLUX_EXPORT_FILE ${bundle.fileName}\n`);
  await pipeline(bundle.content, process.stdout);
} catch (error) {
  if (error instanceof DomainError) fail(`${error.message} (${error.code})${error instanceof ForbiddenError
    ? ': the account may not manage this project; pass --as <email> of a workspace owner or admin' : ''}`);
  throw error;
} finally {
  await pool.end();
}
