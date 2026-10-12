-- Reversal of 0083 (#310 AC-3). The columns only describe how a grant was authorized; no account or grant is lost.
ALTER TABLE agent_oauth_bindings DROP COLUMN auth_confirmed_at, DROP COLUMN auth_idp_sid, DROP COLUMN auth_method;
