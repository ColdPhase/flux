-- F-024 S5a (#313): account safety with a provider.
-- `auth_users.verification_required` marks an account created by password sign-up while sign-up is `verified`; it
-- cannot sign in with its password until its address is verified. Accounts that exist before this migration are
-- unmarked: they keep signing in, and (with email configured) get a verification mail the next time they do.
ALTER TABLE auth_users ADD COLUMN verification_required boolean NOT NULL DEFAULT false;

-- A provider sign-in whose verified email belongs to another account. Pending: that account is unverified and the
-- person may claim the address from the browser that completed the provider sign-in. Claimed: the audit record.
-- `held_by` is the released account's id, kept as text without a foreign key so the record outlives that account.
-- Only the SHA-256 of the cookie token is stored. Sparse after 0071 (0072-0073 belong to other branches).
CREATE TABLE auth_email_claims (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  email text NOT NULL,
  held_by text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  released_email text
);
CREATE INDEX auth_email_claims_held_by_idx ON auth_email_claims (held_by);
