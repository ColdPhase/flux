-- F-022 T3 (#278): the `runtime` transport. A fixed pool of Compose-declared slots, one binding of a
-- slot to one owner, the owner's runtime connections (Claude Code, Codex) and the operator's Commercial
-- Terms statement. Sparse after 0051 (0052–0055 are reserved by open branches).
--
-- agent_runtime_sessions (0034) is unrelated to these tables: it holds mode (b) MCP client sessions.
--
-- No column here can hold a vendor credential: a login lives only in the slot's binding directory,
-- written by the CLI's own flow. Only enumerated display facts are stored; the schema test
-- agent-runtime-schema.test.ts fails if a runtime table gains any other column.

-- Slots as the worker last saw them through runtime-manager. `ready`: a supervisor reported an empty
-- /data on a boot id other than the one that performed the last release, so the slot may be bound.
-- `wiping`: released; waiting for a new boot id with an empty /data. `out_of_pool`: the supervisor could
-- not confirm an empty /data, or the slot disappeared; the operator is told.
CREATE TABLE agent_runtime_slots (
  slot text PRIMARY KEY CHECK (slot ~ '^runtime-[1-9][0-9]{0,2}$'),
  state text NOT NULL CHECK (state IN ('unknown', 'ready', 'held', 'wiping', 'out_of_pool')),
  boot_id uuid,
  wipe_boot_id uuid,
  out_of_pool_reason text CHECK (out_of_pool_reason IN ('data_not_empty', 'release_failed', 'missing')),
  reported_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_slots_out_of_pool_check CHECK ((state = 'out_of_pool') = (out_of_pool_reason IS NOT NULL)),
  CONSTRAINT agent_runtime_slots_wiping_check CHECK (state <> 'wiping' OR wipe_boot_id IS NOT NULL)
);

-- One owner's slot. The id names the binding directory /data/<id>: a canonical version 4 UUID, enforced
-- here and again by the supervisor. Released bindings stay as the owner's history (what Settings tells
-- them); at most one live binding per owner and per slot.
CREATE TABLE agent_runtime_bindings (
  id uuid PRIMARY KEY
    CONSTRAINT agent_runtime_bindings_id_check CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  slot text NOT NULL REFERENCES agent_runtime_slots(slot),
  state text NOT NULL CHECK (state IN ('binding', 'active', 'sign_in_again', 'releasing', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  release_reason text CHECK (release_reason IN ('owner', 'operator', 'idle', 'purge', 'bind_failed')),
  release_requested_at timestamptz,
  released_at timestamptz,
  -- Whether a CLI's own sign-out failed during the release (the files were deleted anyway), so the
  -- owner is told to end the session in their vendor account.
  release_logout_failed boolean,
  CONSTRAINT agent_runtime_bindings_release_check CHECK ((state IN ('releasing', 'released')) = (release_reason IS NOT NULL)
    AND (release_reason IS NULL) = (release_requested_at IS NULL) AND (state = 'released') = (released_at IS NOT NULL)
    AND (state = 'released' OR release_logout_failed IS NULL))
);
CREATE UNIQUE INDEX agent_runtime_bindings_owner_live_idx ON agent_runtime_bindings(owner_user_id) WHERE state <> 'released';
CREATE UNIQUE INDEX agent_runtime_bindings_slot_live_idx ON agent_runtime_bindings(slot) WHERE state <> 'released';
CREATE INDEX agent_runtime_bindings_owner_idx ON agent_runtime_bindings(owner_user_id, created_at DESC, id);

-- A connection with transport `runtime` (F-022 AIM-1): the owner's own Claude Code or Codex in their
-- slot. Sign-in (T4) fills the display facts; nothing else about the login is ever stored.
CREATE TABLE agent_runtime_connections (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE,
  transport text NOT NULL DEFAULT 'runtime' CHECK (transport = 'runtime'),
  client text NOT NULL CHECK (client IN ('claude_code', 'codex')),
  state text NOT NULL CHECK (state IN ('signed_out', 'signed_in', 'sign_in_again')),
  sign_in_method text CHECK (sign_in_method IN ('claude_account', 'console', 'sso', 'device_code', 'api_key', 'access_token')),
  auth_method text CHECK (auth_method ~ '^[a-z][a-z0-9_.-]{0,31}$'),
  plan_label text CHECK (length(plan_label) <= 40 AND plan_label ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]*$'),
  account_label text CHECK (length(account_label) <= 80 AND strpos(account_label, '*') > 0 AND account_label !~ '[[:space:]]'),
  signed_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT agent_runtime_connections_signed_in_check CHECK ((state = 'signed_in') = (signed_in_at IS NOT NULL)),
  CONSTRAINT agent_runtime_connections_method_check CHECK (client <> 'claude_code' OR sign_in_method IS NULL OR sign_in_method IN ('claude_account', 'console', 'sso')),
  CONSTRAINT agent_runtime_connections_codex_method_check CHECK (client <> 'codex' OR sign_in_method IS NULL OR sign_in_method IN ('device_code', 'api_key', 'access_token')),
  CONSTRAINT agent_runtime_connections_revoked_check CHECK (revoked_at IS NULL OR state <> 'signed_in')
);
CREATE UNIQUE INDEX agent_runtime_connections_owner_client_idx ON agent_runtime_connections(owner_user_id, client) WHERE revoked_at IS NULL;

-- F-022 "Commercial Terms": enabling `claude_code` needs the operator's statement that they agreed to
-- Anthropic's Commercial Terms. Flux records the statement and its date; it does not verify it.
CREATE TABLE agent_runtime_operator_statements (
  statement text NOT NULL CHECK (statement = 'anthropic_commercial_terms'),
  agreed_on date NOT NULL CHECK (agreed_on >= DATE '2023-01-01'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (statement, agreed_on)
);
