-- F-027 A3 (#403): the assistant's change log. Every effect call of an assistant run is one row, written in
-- the same transaction as the change it records (or instead of it, when the change waits for the owner).
--   applied              the change was made at once under the run's authority (`owner_request`);
--   waiting              a prepared change waits: for the owner's Apply, for a typist to finish (live Wiki),
--                        or, outside the owner's rights, for the owner to send it as a suggestion;
--   applied_after_wait   the owner applied it (`owner_approval`) or the live-Wiki deferral settled it
--                        (`owner_deferred_change`);
--   not_now / expired    the owner declined it, or seven days passed;
--   undone               A4's Undo restored it;
--   refused              the run could not make it (another person changed the object, or a recheck failed).
-- A waiting row keeps its exact prepared tool call (bounded), never a credential, claim or grant. The row
-- leaves with its project and with its run.
CREATE TABLE assistant_changes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  client_command_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  tool text NOT NULL CHECK (tool ~ '^flux_[a-z_]{1,60}$'),
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 60),
  object_type text NOT NULL CHECK (object_type IN ('work', 'doc', 'map', 'thought', 'link', 'message', 'result', 'decision')),
  object_id uuid,
  object_title text NOT NULL DEFAULT '' CHECK (char_length(object_title) <= 300),
  state text NOT NULL CHECK (state IN ('applied', 'waiting', 'applied_after_wait', 'not_now', 'expired', 'undone', 'refused')),
  wait_reason text CHECK (wait_reason IN ('ask', 'removal', 'others', 'live_wiki', 'limit', 'outside_rights', 'conflict')),
  authority text CHECK (authority IN ('owner_request', 'owner_approval', 'owner_deferred_change')),
  prepared_command jsonb CHECK (prepared_command IS NULL
    OR (jsonb_typeof(prepared_command) = 'object' AND octet_length(prepared_command::text) <= 65536)),
  policy_version integer NOT NULL CHECK (policy_version >= 0),
  before_version integer CHECK (before_version > 0),
  after_version integer CHECK (after_version > 0),
  receipt jsonb CHECK (receipt IS NULL OR (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 65536)),
  refusal text CHECK (refusal IS NULL OR char_length(refusal) <= 500),
  other_user_id text REFERENCES auth_users(id) ON DELETE SET NULL, -- the live typist, or the person whose thing it is
  suggest_to_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  inbox_at timestamptz,
  decided_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, client_command_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, run_id) REFERENCES personal_runs(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assistant_changes_waiting_check CHECK ((state = 'waiting') = (wait_reason IS NOT NULL)),
  CONSTRAINT assistant_changes_prepared_check CHECK (state <> 'waiting' OR prepared_command IS NOT NULL),
  CONSTRAINT assistant_changes_applied_check CHECK (state NOT IN ('applied', 'applied_after_wait', 'undone')
    OR (authority IS NOT NULL AND receipt IS NOT NULL)),
  CONSTRAINT assistant_changes_authority_check CHECK (state <> 'applied' OR authority = 'owner_request'),
  CONSTRAINT assistant_changes_after_wait_check CHECK (state <> 'applied_after_wait' OR authority IN ('owner_approval', 'owner_deferred_change')),
  CONSTRAINT assistant_changes_decided_check CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT assistant_changes_suggestion_check CHECK (sent_at IS NULL OR suggest_to_user_id IS NOT NULL),
  CONSTRAINT assistant_changes_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX assistant_changes_owner_waiting_idx ON assistant_changes(owner_user_id, created_at) WHERE state = 'waiting';
CREATE INDEX assistant_changes_run_idx ON assistant_changes(run_id, created_at);

-- With effect tools a run lists its read tools and its change tools: room for both.
ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_run_tools_check,
  ADD CONSTRAINT personal_runs_run_tools_check CHECK (cardinality(run_tools) <= 64);
