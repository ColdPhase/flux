-- #58: revocation remains terminal history. A new owner authorization starts
-- paused; renewing cannot erase old proposals, dismissals or owner-level charges.
ALTER TABLE proactive_comparison_rules
  DROP CONSTRAINT proactive_comparison_rules_owner_user_id_project_id_purpose_key;
CREATE UNIQUE INDEX proactive_comparison_rules_active_owner_project_idx
  ON proactive_comparison_rules(owner_user_id, project_id, purpose)
  WHERE status <> 'revoked';
INSERT INTO flux_schema_version(version) VALUES (25) ON CONFLICT DO NOTHING;
