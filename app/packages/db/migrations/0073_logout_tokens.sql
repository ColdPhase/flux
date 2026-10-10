-- F-024 S3 (#314): the replay store of OIDC back-channel logout tokens. A logout token's `jti` is accepted
-- once per provider and kept until the token's `exp` (plus the clock tolerance), so a replayed token is
-- refused and the table stays small. It holds no token and no personal data. Sparse after 0070.
CREATE TABLE auth_logout_tokens (
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  jti text NOT NULL CHECK (length(jti) BETWEEN 1 AND 512),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, jti)
);
CREATE INDEX auth_logout_tokens_expires_idx ON auth_logout_tokens (expires_at);
