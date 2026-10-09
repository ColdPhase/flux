-- F-024 S5b (#315): the explicit link of an existing password account to the one chosen provider, before cutover.
-- A pending intent is the proof, from the account's own password session, that this browser may link a provider
-- identity to that account on the next provider round trip. Only the SHA-256 of the cookie token is stored.
-- `used` is set once the identity is linked; an intent expires in minutes and is never reused.
CREATE TABLE auth_link_intents (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  session_id text NOT NULL,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'used')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX auth_link_intents_user_idx ON auth_link_intents (user_id);
