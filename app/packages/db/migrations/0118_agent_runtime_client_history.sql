-- #480 (F-022 T3, #331 "never installed"): a durable, server-owned history of which client may have left a
-- vendor login in a binding. Until now "this client was never installed for the binding" was inferred from an
-- empty binding directory and a missing CLI inside the slot, so a lost directory or tools volume read as
-- "nothing to sign out". The release now asks this table instead.
--
-- One row per (binding, client), written BEFORE the slot is asked to do anything that could create a vendor
-- session: when a sign-in console is claimed (agent_runtime_auth_operations), and when the CLI's own status
-- says signed in. `login_possible` stays true until the CLI's own logout returned `ok` (recordSignOut with
-- failed = false); a failed, timed-out, skipped or unreadable sign-out never clears it. A client with no row
-- never had a login started in the binding, which is the only case where a missing CLI can be confirmed.
--
-- Display facts and timestamps only, like every runtime table (agent-runtime.test.ts reviews each column).
CREATE TABLE agent_runtime_client_history (
  binding_id uuid NOT NULL REFERENCES agent_runtime_bindings(id) ON DELETE CASCADE,
  client text NOT NULL CHECK (client IN ('claude_code', 'codex')),
  first_login_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  login_possible boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, client)
);

-- Backfill for bindings that exist before this migration (live or still releasing). Conservative: a login is
-- possible unless a confirmed sign-out was recorded, and a console that was ever claimed counts as a started
-- login. Released bindings need no history: their release already recorded its outcome.
INSERT INTO agent_runtime_client_history(binding_id, client, first_login_at, login_possible)
SELECT h.binding_id, h.client, min(h.at), bool_or(h.possible)
FROM (
  SELECT c.binding_id, c.client, coalesce(c.signed_in_at, c.signed_out_at, c.created_at) AS at, NOT (c.sign_out_failed IS FALSE) AS possible
  FROM agent_runtime_connections c
  UNION ALL
  SELECT o.binding_id, o.client, o.claimed_at, true
  FROM agent_runtime_auth_operations o WHERE o.kind = 'console'
) h
JOIN agent_runtime_bindings b ON b.id = h.binding_id AND b.state <> 'released'
GROUP BY h.binding_id, h.client;

-- #331 nit (the `account_label` CHECK is weak): the stored label has exactly the shape the slot's reducer can send
-- (ACCOUNT_LABEL in @flux/runtime-protocol: a first character, `***@`, a domain), not merely "bounded and contains a
-- star". Any label of another shape (the reducer never writes one) is dropped first; a label is a display fact.
UPDATE agent_runtime_connections SET account_label = NULL
  WHERE account_label IS NOT NULL AND account_label !~ '^[A-Za-z0-9*]\*\*\*@[A-Za-z0-9.*-]{1,70}$';
UPDATE agent_runtime_connections SET previous_account_label = NULL
  WHERE previous_account_label IS NOT NULL AND previous_account_label !~ '^[A-Za-z0-9*]\*\*\*@[A-Za-z0-9.*-]{1,70}$';
ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_account_label_check;
ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_account_label_check
  CHECK (account_label ~ '^[A-Za-z0-9*]\*\*\*@[A-Za-z0-9.*-]{1,70}$');
ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_previous_label_check;
ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_previous_label_check
  CHECK (previous_account_label ~ '^[A-Za-z0-9*]\*\*\*@[A-Za-z0-9.*-]{1,70}$');
