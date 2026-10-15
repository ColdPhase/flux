-- F-022 T4/#279: server-owned auth admission and nonce consumption. These are
-- bounded metadata, not CLI output, credentials, tickets or session tokens.
ALTER TABLE agent_runtime_bindings DROP CONSTRAINT agent_runtime_bindings_release_reason_check;
ALTER TABLE agent_runtime_bindings ADD CONSTRAINT agent_runtime_bindings_release_reason_check
  CHECK (release_reason IN ('owner', 'operator', 'idle', 'purge', 'bind_failed', 'auth_recovery'));

CREATE TABLE agent_runtime_auth_operations (
  binding_id uuid NOT NULL REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE,
  client text NOT NULL CHECK (client IN ('claude_code', 'codex')),
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE
    CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  revision integer NOT NULL CHECK (revision > 0),
  boot_id uuid NOT NULL,
  actor_digest text NOT NULL CHECK (actor_digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('check', 'logout', 'console')),
  phase text NOT NULL CHECK (phase IN ('active', 'settled', 'uncertain')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_ends_at timestamptz NOT NULL,
  hard_ends_at timestamptz NOT NULL,
  settled_at timestamptz,
  PRIMARY KEY (binding_id, client),
  CHECK (claimed_at < lease_ends_at AND lease_ends_at <= hard_ends_at),
  CHECK ((phase = 'settled') = (settled_at IS NOT NULL))
);
CREATE INDEX agent_runtime_auth_expiry_idx ON agent_runtime_auth_operations(lease_ends_at) WHERE phase = 'active';

-- The digest of a verified random console nonce, consumed in the claim's short
-- transaction. Expiry is checked using DB wall time; no raw signed ticket is stored.
CREATE TABLE agent_runtime_console_nonces (
  nonce_digest text PRIMARY KEY CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  actor_digest text NOT NULL CHECK (actor_digest ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (consumed_at < expires_at)
);

-- A durable project-wide operator purge barrier. It is cleared only after
-- acknowledged cleanup; restarting an API or reaching a TTL never clears it.
CREATE TABLE agent_runtime_auth_admission (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  blocked boolean NOT NULL DEFAULT false,
  purge_id uuid,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (blocked = (purge_id IS NOT NULL))
);
INSERT INTO agent_runtime_auth_admission(singleton) VALUES (true);

-- Even lifecycle paths outside an API invalidate completions. A row fence is
-- not proof the old process stopped: recovery must still recycle the full binding.
CREATE FUNCTION invalidate_runtime_auth_operations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'active' THEN
    UPDATE agent_runtime_auth_operations SET phase = 'uncertain', settled_at = NULL
      WHERE binding_id = NEW.id AND phase = 'active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runtime_auth_lifecycle AFTER UPDATE OF state ON agent_runtime_bindings
  FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_auth_operations();
