-- Reversal of 0118 (#480). It is not applied by the migrator and never edits the schema ledger: a reversal
-- runner owns that. The history is the only server-side record that a client may have left a vendor login
-- in a binding, so it is not dropped while a binding that is not released still says one is possible.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_runtime_client_history h JOIN agent_runtime_bindings b ON b.id = h.binding_id
    WHERE h.login_possible AND b.state <> 'released') THEN
    RAISE EXCEPTION '0118 reversal refused: a live binding may still hold a vendor login; release it (or purge) first';
  END IF;
END $$;
DROP TABLE agent_runtime_client_history;
-- The stricter label checks go back to 0056/0096's bounded form. Stored labels all satisfy it.
ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_account_label_check;
ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_account_label_check
  CHECK (length(account_label) <= 80 AND strpos(account_label, '*') > 0 AND account_label !~ '[[:space:]]');
ALTER TABLE agent_runtime_connections DROP CONSTRAINT agent_runtime_connections_previous_label_check;
ALTER TABLE agent_runtime_connections ADD CONSTRAINT agent_runtime_connections_previous_label_check
  CHECK (length(previous_account_label) <= 80 AND strpos(previous_account_label, '*') > 0 AND previous_account_label !~ '[[:space:]]');
