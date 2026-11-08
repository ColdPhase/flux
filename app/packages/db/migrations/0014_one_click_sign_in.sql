-- #859 step 2 (F-036 LC-1, mcp-cowork): a local client signs in once and acts with its owner's rights. There are no scopes,
-- no capability switches and no project selection: what a client reaches is what its owner reaches at the moment of each call,
-- and what it may change is the agent's "What it may do". Flux has no installations or data yet (founder, 2026-10-31): nothing
-- is converted.
DROP TABLE public.agent_connection_mcp_projects;
DROP TABLE public.agent_connection_mcp_policies;
DROP TABLE public.agent_connection_projects;
ALTER TABLE public.agent_connections DROP COLUMN scopes;
DROP TABLE public.agent_oauth_flows;
DROP TABLE public.agent_oauth_selections;
ALTER TABLE public.agent_runtime_sessions DROP COLUMN scopes;
ALTER TABLE public.assistant_changes DROP COLUMN policy_version;
