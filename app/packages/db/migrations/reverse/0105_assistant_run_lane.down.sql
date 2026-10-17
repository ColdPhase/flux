-- A rollback restores one run in flight per owner; a request waiting behind a working one is ended at zero cost first.
UPDATE personal_runs SET status = 'stopped', cost_state = 'released', charged_micros = 0, completed_at = now(), updated_at = now()
  WHERE status = 'queued' AND owner_user_id IN (SELECT owner_user_id FROM personal_runs WHERE status IN ('reading', 'dispatching'));
UPDATE personal_runs q SET status = 'stopped', cost_state = 'released', charged_micros = 0, completed_at = now(), updated_at = now()
  WHERE q.status = 'queued' AND EXISTS (SELECT 1 FROM personal_runs o WHERE o.owner_user_id = q.owner_user_id AND o.status = 'queued' AND (o.created_at, o.id) < (q.created_at, q.id));
DROP INDEX personal_runs_queued_idx;
DROP INDEX personal_runs_one_working_idx;
CREATE UNIQUE INDEX personal_runs_one_in_flight_idx ON personal_runs(owner_user_id)
  WHERE status IN ('queued', 'reading', 'dispatching');
