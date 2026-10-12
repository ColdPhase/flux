-- #310 AC-3: immutable provenance per redeemed authorization-code family. No browser-session FK.
CREATE TABLE oauth_grant_authentication (
  authorization_code_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  reference_id text NOT NULL,
  auth_method text NOT NULL CHECK (length(auth_method) BETWEEN 1 AND 200),
  auth_idp_sid text CHECK (auth_idp_sid IS NULL OR length(auth_idp_sid) BETWEEN 1 AND 512),
  auth_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grant_authentication_user_idx ON oauth_grant_authentication(user_id);

-- Preserve existing families without attributing them to a later sign-in. If their original browser
-- session has gone, provenance is explicitly unknown; never copy the overwritten binding metadata.
INSERT INTO oauth_grant_authentication
  (authorization_code_id, user_id, reference_id, auth_method, auth_idp_sid, auth_confirmed_at, created_at)
SELECT DISTINCT ON (r.authorization_code_id) r.authorization_code_id, r.user_id, r.reference_id,
  COALESCE(i.method, 'unknown'), i.idp_sid, COALESCE(i.confirmed_at, r.created_at), r.created_at
FROM oauth_refresh_token r LEFT JOIN auth_session_identities i ON i.session_id = r.session_id
WHERE r.authorization_code_id IS NOT NULL AND r.reference_id IS NOT NULL
ORDER BY r.authorization_code_id, r.created_at;
