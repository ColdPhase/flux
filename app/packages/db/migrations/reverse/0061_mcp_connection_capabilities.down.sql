-- Never silently remove a saved restriction and widen a personal connection.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_connection_mcp_policies) THEN
    RAISE EXCEPTION 'MCP policies exist; restore the matching image/database or explicitly remove the affected connections before reversing 0061';
  END IF;
END $$;
DROP TABLE agent_connection_mcp_projects;
DROP TABLE agent_connection_mcp_policies;
DELETE FROM flux_schema_version WHERE version = 61;
