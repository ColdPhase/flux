-- #74 G-1a: "Let linked PRs move this task". A person who can edit a task turns its rule on; the rule then moves
-- the same native task from current provider facts of its required PR links (opened, failing checks, merged, closed
-- without merge). Additive: new tables only. Number recorded on #153; 0053 stays unused and 0054 is #261's.
-- A binding that is disconnected, uninstalled, removed from the installation or loses its authorization suspends
-- every active rule that reads it; only an explicit Resume restarts it, also after the repository is bound again.

-- One rule per task. The author is the person on whose current Flux and GitHub authority it acts; their GitHub
-- identity and authorization generation are captured so a reconnect as another account never inherits it.
-- `expected_*` is the task state the rule last saw: a later manual change of status or blocker suspends it.
-- `blocked_by` is set only while the task is blocked by this rule, so it never clears a blocker a person wrote.
CREATE TABLE github_task_rules (
  task_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('complete', 'ready')),
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'off')),
  suspended_reason text CHECK (suspended_reason IN ('manual_change', 'author_access', 'repository_unavailable')),
  author_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  author_github_user_id text NOT NULL CHECK (author_github_user_id ~ '^[1-9][0-9]*$'),
  author_generation uuid NOT NULL,
  app_id text NOT NULL CHECK (app_id ~ '^[1-9][0-9]*$'),
  expected_version integer NOT NULL CHECK (expected_version >= 1),
  expected_status text NOT NULL CHECK (expected_status IN ('open', 'in_progress', 'blocked', 'done', 'not_pursued')),
  expected_blocker text,
  blocked_by text CHECK (blocked_by IN ('check', 'closed')),
  ready_to_close boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'suspended') = (suspended_reason IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);

-- Every automatic change and suspension, with the PR, head commit, check and the delivery or local reconciliation
-- whose current facts caused it. Delivery ids are kept as text: raw deliveries expire after seven days. A local
-- disconnect, authorization revocation or restore (`binding`) has no delivery.
CREATE TABLE github_task_rule_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('pull_open', 'pull_reopened', 'check_failed', 'checks_passed', 'pull_closed',
    'merged_done', 'merged_ready', 'suspended_manual', 'suspended_access', 'suspended_repository')),
  from_status text NOT NULL CHECK (from_status IN ('open', 'in_progress', 'blocked', 'done', 'not_pursued')),
  to_status text NOT NULL CHECK (to_status IN ('open', 'in_progress', 'blocked', 'done', 'not_pursued')),
  blocker text,
  ready_to_close boolean NOT NULL,
  author_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  link_id uuid,
  pull_number integer CHECK (pull_number >= 1),
  head_sha text CHECK (head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  check_name text CHECK (char_length(check_name) <= 200),
  delivery_id text,
  binding_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('webhook', 'reconcile', 'binding')),
  task_version integer NOT NULL CHECK (task_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'binding') = (delivery_id IS NULL)),
  UNIQUE (task_id, delivery_id, binding_id),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX github_task_rule_changes_task_idx ON github_task_rule_changes(task_id, created_at DESC, id DESC);

-- A project manager's default: a writer who links a required PR to a task without a rule turns its rule on, as its author.
CREATE TABLE github_rule_defaults (
  project_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  mode text CHECK (mode IN ('complete', 'ready')),
  set_by_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
