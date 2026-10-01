/** Accepted #58 inactivity bound, distinct from quiet time and provider timeout. */
export const COMPARISON_RESERVATION_STALE_MS = 20 * 60_000;
export const COMPARISON_RECOVERY_BATCH = 100;

export interface RecoverableComparisonReservation {
  id: string; status: string; updatedAt: Date; dispatchStartedAt: Date | null;
}
export interface ComparisonRecoveryPorts {
  /** Metadata only. Hold row locks to commit; skip rows locked by preparation. */
  lockStale(cutoff: Date, limit: number): Promise<RecoverableComparisonReservation[]>;
  notRun(id: string, cutoff: Date, at: Date): Promise<boolean>;
  unknown(id: string, cutoff: Date, at: Date): Promise<boolean>;
}
export interface ComparisonRecoveryUnitOfWork {
  run<T>(action: (ports: ComparisonRecoveryPorts) => Promise<T>): Promise<T>;
}

/** No source, credential, event or provider port. An intent is only possible spending. */
export function recoverComparisonReservations(unit: ComparisonRecoveryUnitOfWork, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('A valid recovery time is required');
  const cutoff = new Date(now.getTime() - COMPARISON_RESERVATION_STALE_MS);
  return unit.run(async (ports) => {
    const rows = await ports.lockStale(cutoff, COMPARISON_RECOVERY_BATCH);
    let notRun = 0; let unknown = 0;
    for (const row of rows) {
      if (row.status !== 'reserved' || !Number.isFinite(row.updatedAt.getTime()) || row.updatedAt > cutoff)
        throw new Error('Recovery requires a locked stale reservation');
      const changed = row.dispatchStartedAt === null
        ? await ports.notRun(row.id, cutoff, now) : await ports.unknown(row.id, cutoff, now);
      if (!changed) throw new Error('The locked recovery reservation changed');
      if (row.dispatchStartedAt === null) notRun++; else unknown++;
    }
    return { considered: rows.length, notRun, unknown };
  });
}
