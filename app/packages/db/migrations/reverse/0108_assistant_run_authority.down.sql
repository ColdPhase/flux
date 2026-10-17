-- A rollback forgets what started a run; background runs that are still waiting are ended at zero cost first.
UPDATE personal_runs SET status = 'stopped', cost_state = 'released', charged_micros = 0, completed_at = now(), updated_at = now()
  WHERE status = 'queued' AND authority <> 'owner_request';
DROP INDEX personal_runs_queued_idx;
CREATE INDEX personal_runs_queued_idx ON personal_runs(created_at, id) WHERE status = 'queued';
ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_authority_label_check, DROP COLUMN background_label, DROP COLUMN authority;
