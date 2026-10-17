-- A rollback forgets schedules, their history, the notes seen and the written summaries. Background runs lose their kind,
-- so they are removed with their changes (the change log leaves with its run).
DELETE FROM personal_runs WHERE kind IN ('scheduled', 'morning_summary');
ALTER TABLE personal_runs DROP COLUMN silent;
ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_kind_check;
ALTER TABLE personal_runs ADD CONSTRAINT personal_runs_kind_check CHECK (kind IN ('ask', 'summarize', 'map_thought'));
DROP TABLE assistant_morning_summaries;
ALTER TABLE notification_preferences DROP COLUMN summary_by_assistant;
DROP TABLE assistant_background_notes;
DROP TABLE assistant_job_runs;
DROP TABLE assistant_jobs;
