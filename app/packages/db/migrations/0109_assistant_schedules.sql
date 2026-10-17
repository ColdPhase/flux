-- F-027 A8 (#408): "On a schedule" and the morning summary written by the assistant (AST-7, AST-2.1).
--
-- assistant_jobs         the owner's schedules: a sentence, one project, a time (a kind with its fields, or a five-field
--                        cron expression) in the owner's time zone. Off until the owner's own tap ("prepared" ones were
--                        made from a request). `next_run_at` is the one thing the per-minute tick selects on.
-- assistant_job_runs     the history: one row per firing. UNIQUE (job_id, fired_at, fired_by) is what makes two workers
--                        start exactly one run; the partial unique index keeps one run at a time per schedule.
-- assistant_background_notes  the owner saw the note about background use of a subscription (AST-2.1), once per account.
-- assistant_morning_summaries one row per owner and local day while the assistant writes the summary; the plain #350
--                        summary goes out instead when the run fails (AST-7.6).
-- personal_runs          two more kinds (`scheduled`, `morning_summary`) and `silent`: the run's answer is not shown in
--                        its conversation (a schedule keeps its result in Recent unless it posts into a conversation).

CREATE TABLE assistant_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('daily', 'weekdays', 'weekly', 'hourly', 'cron', 'once')),
  schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'object' AND octet_length(schedule::text) <= 1000),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  -- The conversation the result is posted in (More), or the one a "Do it at 14:00" belongs to.
  conversation_id uuid,
  post_to_conversation boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  prepared boolean NOT NULL DEFAULT false,
  -- The owner's request that prepared it (AST-7 "Set up by asking"), so the conversation can offer *Turn on* under that answer.
  prepared_run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
  paused_reason text CHECK (paused_reason IN ('failures')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  failure_streak integer NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, conversation_id) REFERENCES project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT assistant_jobs_due_check CHECK (next_run_at IS NULL OR enabled)
);
CREATE INDEX assistant_jobs_due_idx ON assistant_jobs(next_run_at) WHERE enabled AND deleted_at IS NULL;
CREATE INDEX assistant_jobs_owner_idx ON assistant_jobs(owner_user_id, created_at, id) WHERE deleted_at IS NULL;

CREATE TABLE assistant_job_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES assistant_jobs(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL,
  fired_by text NOT NULL CHECK (fired_by IN ('schedule', 'now')),
  run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('running', 'done', 'skipped', 'failed')),
  result_line text NOT NULL DEFAULT '' CHECK (char_length(result_line) <= 300),
  needs_you boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_id, fired_at, fired_by),
  CONSTRAINT assistant_job_runs_finished_check CHECK ((state = 'running') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX assistant_job_runs_one_running_idx ON assistant_job_runs(job_id) WHERE state = 'running';
CREATE INDEX assistant_job_runs_history_idx ON assistant_job_runs(job_id, fired_at DESC);
CREATE INDEX assistant_job_runs_owner_day_idx ON assistant_job_runs(owner_user_id, started_at) WHERE state <> 'skipped';
CREATE INDEX assistant_job_runs_run_idx ON assistant_job_runs(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE assistant_background_notes (
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  -- `runtime:claude_code`, `runtime:codex` or `server:<connection id>`: the account the note was shown for.
  account_key text NOT NULL CHECK (char_length(account_key) BETWEEN 1 AND 100),
  note_version text NOT NULL CHECK (char_length(note_version) BETWEEN 1 AND 64),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, account_key)
);

ALTER TABLE notification_preferences ADD COLUMN summary_by_assistant boolean NOT NULL DEFAULT false;

CREATE TABLE assistant_morning_summaries (
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  day date NOT NULL,
  run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
  -- `writing`: the run is on its way; `written`: the line is on Home and its one push went out; `plain`: the #350
  -- summary went out instead (or nothing, with an empty inbox).
  state text NOT NULL CHECK (state IN ('writing', 'written', 'plain')),
  line text CHECK (line IS NULL OR char_length(line) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (owner_user_id, day),
  CONSTRAINT assistant_morning_summaries_written_check CHECK ((state = 'written') = (line IS NOT NULL))
);
CREATE INDEX assistant_morning_summaries_writing_idx ON assistant_morning_summaries(created_at) WHERE state = 'writing';

ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_kind_check;
ALTER TABLE personal_runs ADD CONSTRAINT personal_runs_kind_check CHECK (kind IN ('ask', 'summarize', 'map_thought', 'scheduled', 'morning_summary'));
ALTER TABLE personal_runs ADD COLUMN silent boolean NOT NULL DEFAULT false;
