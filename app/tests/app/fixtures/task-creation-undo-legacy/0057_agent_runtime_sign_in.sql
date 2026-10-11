-- F-022 T4 (#279): the Claude Code sign-in console. A `runtime` connection keeps the display facts of
-- its sign-in (0056) and gains what the owner is told afterwards:
--
-- - the account-change notice (F-022 "Sign-in as in a terminal", step 5): a sign-in to a different
--   account than the last one shows the previous masked label and when it changed, until the owner
--   dismisses it. Accounts are compared by a keyed fingerprint (HMAC-SHA-256, hex) of the digest the
--   slot reports for the account's address and organization; it is compared, never shown, and its key
--   lives only in the API's configuration;
-- - the last sign-out, and whether the CLI's own logout failed (the files were deleted anyway; the
--   owner is told to end the session at the vendor).
--
-- Still no column can hold a credential: the fingerprint is exactly 64 hex digits, labels are masked
-- (agent-runtime.test.ts reviews every column).
ALTER TABLE agent_runtime_connections
  ADD COLUMN account_fingerprint text CONSTRAINT agent_runtime_connections_fingerprint_check CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN previous_account_label text CONSTRAINT agent_runtime_connections_previous_label_check
    CHECK (length(previous_account_label) <= 80 AND strpos(previous_account_label, '*') > 0 AND previous_account_label !~ '[[:space:]]'),
  ADD COLUMN account_changed_at timestamptz,
  ADD COLUMN signed_out_at timestamptz,
  ADD COLUMN sign_out_failed boolean,
  ADD CONSTRAINT agent_runtime_connections_notice_check CHECK (account_changed_at IS NOT NULL OR previous_account_label IS NULL),
  ADD CONSTRAINT agent_runtime_connections_sign_out_check CHECK ((signed_out_at IS NULL) = (sign_out_failed IS NULL));
