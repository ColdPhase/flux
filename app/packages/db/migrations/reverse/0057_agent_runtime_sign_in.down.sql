-- Reversal of 0057 (#279). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. It drops only display facts and notices; the logins themselves live in
-- the slot volumes and are unaffected.
ALTER TABLE agent_runtime_connections
  DROP CONSTRAINT agent_runtime_connections_sign_out_check,
  DROP CONSTRAINT agent_runtime_connections_notice_check,
  DROP COLUMN sign_out_failed,
  DROP COLUMN signed_out_at,
  DROP COLUMN account_changed_at,
  DROP COLUMN previous_account_label,
  DROP COLUMN account_fingerprint;
