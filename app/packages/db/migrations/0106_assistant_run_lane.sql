-- F-027 A4 (#404): one lane per owner, with one request waiting behind the working one (AST-6 "Queue").
-- O-008 allowed one personal run in flight per owner. Now at most one run is working (reading or dispatching); a second
-- request may wait queued behind it and starts when the first ends. The service caps queued + working at two.
DROP INDEX personal_runs_one_in_flight_idx;
CREATE UNIQUE INDEX personal_runs_one_working_idx ON personal_runs(owner_user_id)
  WHERE status IN ('reading', 'dispatching');
CREATE INDEX personal_runs_queued_idx ON personal_runs(created_at, id) WHERE status = 'queued';
