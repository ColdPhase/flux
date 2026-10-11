-- F-024 S1 (#310): how each browser session was signed in. `method` is 'password' or the provider id
-- (derived from the issuer, #240); `idp_sid` is the provider's own session id from its ID token, kept so
-- a back-channel logout (S3) can find the sessions it ends; `confirmed_at` is when the provider (or the
-- password) last vouched for the identity. It holds no token: the provider's access, ID and refresh
-- tokens are never stored in auth_accounts or here. Sparse after 0056 (0057-0065 belong to other branches).
CREATE TABLE auth_session_identities (
  session_id text PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 200),
  idp_sid text CHECK (idp_sid IS NULL OR length(idp_sid) BETWEEN 1 AND 512),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_identities_idp_sid_idx ON auth_session_identities (method, idp_sid) WHERE idp_sid IS NOT NULL;
