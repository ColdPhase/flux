-- F-024 S4 (#311): the standing check of a person's account at the identity provider. One row per
-- (person, provider). `refresh_token_enc` is the provider's offline refresh token, sealed with a key derived
-- from FLUX_AUTH_SECRET for this use only (AES-256-GCM, bound to the row); it is never written to
-- auth_accounts. `./flux backup` dumps this table's definition but not its rows, so after a restore every
-- managed person is 'sign_in_required' until they sign in through the provider again.
-- `state` is what every gate reads; `next_check_at` and the short lease (`lease_id`, `lease_until`) drive the
-- checker in the api service so that no database lock is held while the provider is called.
-- Sparse after 0066 (0067-0069 belong to other branches).
CREATE TABLE auth_idp_standing (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'sign_in_required')),
  reason text CHECK (reason IS NULL OR length(reason) <= 100),
  refresh_token_enc text CHECK (refresh_token_enc IS NULL OR length(refresh_token_enc) <= 16384),
  confirmed_at timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  last_check_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN ('success', 'sign_in_required', 'unknown')),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease_id text,
  lease_until timestamptz,
  PRIMARY KEY (user_id, provider_id)
);
CREATE INDEX auth_idp_standing_due_idx ON auth_idp_standing (next_check_at) WHERE refresh_token_enc IS NOT NULL;
CREATE INDEX auth_idp_standing_refused_idx ON auth_idp_standing (user_id) WHERE state = 'sign_in_required';
