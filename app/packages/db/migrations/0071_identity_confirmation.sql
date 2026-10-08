-- F-024 S2 (#312): when the identity provider last vouched for a person. It belongs to the provider
-- identity (the auth_accounts row), not to a browser session, so it outlives sign-out and covers MCP tokens
-- that have no session. A provider sign-in sets it; the standing check (S4) will renew it. Password
-- accounts never use it. Existing provider accounts take the newest session that signed in with that
-- provider, else when the account was last written, so nobody is locked out by the upgrade itself.
-- Sparse after 0066 (0067-0070 belong to other branches).
ALTER TABLE auth_accounts ADD COLUMN confirmed_at timestamptz;
UPDATE auth_accounts a SET confirmed_at = COALESCE(
  (SELECT max(i.confirmed_at) FROM auth_session_identities i JOIN auth_sessions s ON s.id = i.session_id
    WHERE s.user_id = a.user_id AND i.method = a.provider_id),
  a.updated_at)
WHERE a.provider_id NOT IN ('credential');
