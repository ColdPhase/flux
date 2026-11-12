import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/** Structurally core's `RunLivePiece` (personal-runs/ports.ts); @flux/db does not import @flux/core. */
export type RunLivePiece = { runId: string; turn: number; at: number; text: string } | { runId: string; step: string };

/** PostgreSQL channel of the asker's live view of a run (#1248): one notification per piece, never stored. */
export const RUN_TEXT_CHANNEL = 'flux_run_text';

/** What one notification of `RUN_TEXT_CHANNEL` carries: the piece and the one person it is for. */
export type RunTextNotice = RunLivePiece & { ownerUserId: string };

/**
 * The worker's side of the live view (#1248): a NOTIFY on its own channel, no row written, no event, no job. The API's stream sends
 * each piece to the run owner's open connections only; a piece nobody listens for is gone.
 */
export function runLiveText(db: Pick<DbExecutor, 'execute'>): { send(ownerUserId: string, piece: RunLivePiece): Promise<void> } {
  return {
    async send(ownerUserId: string, piece: RunLivePiece) {
      const notice: RunTextNotice = { ...piece, ownerUserId };
      await db.execute(sql`SELECT pg_notify(${RUN_TEXT_CHANNEL}, ${JSON.stringify(notice)})`);
    },
  };
}
