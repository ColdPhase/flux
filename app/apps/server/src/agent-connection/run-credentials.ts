import { sql } from 'drizzle-orm';
import { DomainError } from '@flux/core';
import type { DbExecutor } from '@flux/db';
import { scanPieces, scanRunText, type RunScanOutcome } from '@flux/runtime-protocol';
import { argumentText } from './run-private-text.js';
import { toolError } from './tool-results.js';

// A run on the owner's Claude Code or Codex never sends its CLI's own vendor login out through Flux (coordinator decision on #1437, RT-5,
// RT-7). The login stays in the runtime: what a change tool is about to write is sent to the run's supervisor, which alone knows the values,
// and only "found" comes back. A file `flux_attach_file` reads from the scratch is looked through by the supervisor as it is read.

let manager: { url: string; secret: string } | null = null;
/** The runtime-manager the API reaches (null: no runtime on this server, so no run has a CLI login). */
export function configureRunCredentialScan(next: { url: string; secret: string } | null) { manager = next; }

const FOUND = 'That change holds the sign-in of the AI tool you run on (a value of its login file). It was not made, and nothing of it was kept. '
  + 'Never copy anything of your own login into Flux.';
const UNCHECKED = 'Flux could not check that change for the sign-in of the AI tool you run on, so it was not made. Try it once more.';

/** Whether `text` holds the run's CLI login, asked of its supervisor piece by piece; null: the run is not a CLI run in the runtime. */
export async function runTextHoldsCredential(db: DbExecutor, runId: string, text: string): Promise<RunScanOutcome | null> {
  if (!manager) return null;
  const result = await db.execute<{ engine: string; binding_id: string | null; slot: string | null }>(sql`
    SELECT r.engine, b.id AS binding_id, b.slot FROM personal_runs r
    LEFT JOIN agent_runtime_bindings b ON b.owner_user_id = r.owner_user_id AND b.state = 'active'
    WHERE r.id = ${runId} LIMIT 1`);
  const row = result.rows[0];
  if (!row || row.engine !== 'runtime') return null;
  if (!row.binding_id || !row.slot) return { ok: false, code: 'no_binding' };
  for (const piece of scanPieces(text.split('\u0000').join(''))) {
    const outcome = await scanRunText(manager, row.slot, { bindingId: row.binding_id, runId, text: piece });
    if (!outcome.ok || outcome.found) return outcome;
  }
  return { ok: true, found: false };
}

/** A run's change refused because it would write its CLI's login (or could not be checked); null when it may go on. */
export async function refusedCredential(db: DbExecutor, runId: string, args: Record<string, unknown>) {
  const text = argumentText(args).join('\n');
  // No credential value is shorter than 20 characters (supervisor/credentials.ts).
  if (text.length < 20) return null;
  const outcome = await runTextHoldsCredential(db, runId, text);
  if (!outcome) return null;
  if (outcome.ok && !outcome.found) return null;
  return toolError(new DomainError(422, 'CHANGE_HOLDS_CREDENTIAL', outcome.ok ? FOUND : UNCHECKED));
}
