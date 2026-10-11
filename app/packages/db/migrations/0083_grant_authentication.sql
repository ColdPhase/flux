-- F-024 S1 (#310 AC-3): the agent binding that every MCP grant refers to keeps how its authorizing
-- sign-in happened, so the grant outlives the browser session it was consented in. A fresh consent
-- replaces these facts; refresh does not touch them. Only identity facts, never a token.
ALTER TABLE agent_oauth_bindings
  ADD COLUMN auth_method text CHECK (auth_method IS NULL OR length(auth_method) BETWEEN 1 AND 200),
  ADD COLUMN auth_idp_sid text CHECK (auth_idp_sid IS NULL OR length(auth_idp_sid) BETWEEN 1 AND 512),
  ADD COLUMN auth_confirmed_at timestamptz;
