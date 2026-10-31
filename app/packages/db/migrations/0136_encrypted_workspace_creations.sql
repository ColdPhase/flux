-- F-030 encrypted workspaces, S3 security review (#670): encrypted-space creation is a production route that any signed-in
-- person can call, and each one runs two Argon2id derivations. Five creations per person in 15 minutes
-- (docs/product/encrypted-workspaces.md#password-checks): a row is reserved before the derivations and kept on success.
-- No workspace column: the row is reserved before the workspace exists. A system table (rate limit, no content).
CREATE TABLE encrypted_workspace_creations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX encrypted_workspace_creations_person ON encrypted_workspace_creations (user_id, at);
