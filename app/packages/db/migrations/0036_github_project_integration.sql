CREATE TABLE github_credentials (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, host text NOT NULL DEFAULT 'github.com' CHECK(host='github.com'),
  generation uuid NOT NULL, github_user_id text NOT NULL CHECK(github_user_id ~ '^[1-9][0-9]*$'), app_id text NOT NULL CHECK(app_id ~ '^[1-9][0-9]*$'),
  encrypted_tokens text, expires_at timestamptz, refresh_expires_at timestamptz,
  state text NOT NULL CHECK(state IN ('active','refreshing','uncertain','revoked')), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,host)
);
CREATE TABLE github_oauth_flows (
  state_hash text PRIMARY KEY, id uuid NOT NULL, user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('authorize','install')), encrypted_verifier text, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE github_bindings (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, host text NOT NULL DEFAULT 'github.com' CHECK(host='github.com'),
  installation_id text NOT NULL CHECK(installation_id ~ '^[1-9][0-9]*$'), repository_id text NOT NULL CHECK(repository_id ~ '^[1-9][0-9]*$'),
  owner text NOT NULL, name text NOT NULL, private boolean NOT NULL, url text NOT NULL,
  author_user_id text REFERENCES auth_users(id) ON DELETE SET NULL, author_github_user_id text NOT NULL, app_id text NOT NULL, authorization_generation uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disconnected','revoked')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,project_id,id), UNIQUE(project_id,host,repository_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE github_task_links (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL, binding_id uuid NOT NULL,
  pull_id text NOT NULL CHECK(pull_id ~ '^[1-9][0-9]*$'), role text NOT NULL CHECK(role IN ('required_output','related')),
  facts jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(), state text NOT NULL DEFAULT 'current' CHECK(state IN ('current','stale','unavailable')),
  UNIQUE(task_id,binding_id,pull_id,role),
  FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES project_work_items(workspace_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,project_id,binding_id) REFERENCES github_bindings(workspace_id,project_id,id) ON DELETE CASCADE
);
CREATE TABLE github_deliveries (
  id text PRIMARY KEY, app_id text NOT NULL, digest text NOT NULL, event text NOT NULL, payload jsonb NOT NULL,
  installation_id text, repository_id text, provider_object_id text,
  target_binding_id uuid REFERENCES github_bindings(id) ON DELETE SET NULL,
  origin text NOT NULL CHECK(origin IN ('webhook','reconcile')), received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_processing (
  delivery_id text NOT NULL REFERENCES github_deliveries(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES github_bindings(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')), attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text, PRIMARY KEY(delivery_id,binding_id)
);
CREATE INDEX github_processing_due_idx ON github_processing(state,next_attempt_at);
CREATE TABLE github_bridge_outbox (
  id uuid PRIMARY KEY, delivery_id text NOT NULL, binding_id uuid NOT NULL,
  link_id uuid NOT NULL REFERENCES github_task_links(id) ON DELETE CASCADE,
  task_id uuid NOT NULL, workspace_id uuid NOT NULL, project_id uuid NOT NULL, head_sha text NOT NULL,
  event text NOT NULL, provider_object_id text, correlation_key text NOT NULL, state text NOT NULL DEFAULT 'pending_audience_adapter' CHECK(state='pending_audience_adapter'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(delivery_id,binding_id,link_id), UNIQUE(binding_id,link_id,correlation_key)
);
