import { COMPARISON_RECOVERY_BATCH, recoverComparisonReservations, type ComparisonRecoveryUnitOfWork, type Database } from '@flux/core';
import { comparisonRecoveryRows } from '@flux/db';

/** Controlled sweep only; not registered in production. Never dispatches or retries. */
export async function comparisonRecoveryTick(db: Database, now = new Date()) {
  const unit: ComparisonRecoveryUnitOfWork = { run: (action) =>
    db.transaction((tx) => action(comparisonRecoveryRows(tx))) };
  let notRun = 0; let unknown = 0;
  for (;;) {
    const result = await recoverComparisonReservations(unit, now);
    notRun += result.notRun; unknown += result.unknown;
    if (result.considered < COMPARISON_RECOVERY_BATCH) break;
  }
  return { notRun, unknown };
}
