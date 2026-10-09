-- F-024 S5b (#315): audit of operator re-keys and of provider unlinks. Every row names the account, the provider,
-- the subjects before and after, the actor and the reason. Rows are never edited; they outlive the account (no FK).
CREATE TABLE auth_identity_audit (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (action IN ('rekey', 'unlink')),
  user_id text NOT NULL,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  old_subject text,
  new_subject text,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  mode text NOT NULL CHECK (mode IN ('prepare', 'sso'))
);
CREATE INDEX auth_identity_audit_user_idx ON auth_identity_audit (user_id);
