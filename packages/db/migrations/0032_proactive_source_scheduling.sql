-- #58: committed source changes coalesce independently of notifications. No content
-- or provider credentials enter cursor/reconsideration rows. Numbers follow merge order.
CREATE TABLE proactive_comparison_cursor (
  id integer PRIMARY KEY CHECK (id = 1),
  seq bigint NOT NULL CHECK (seq >= 0)
);
INSERT INTO proactive_comparison_cursor(id, seq) VALUES (1, 0);
CREATE TABLE proactive_comparison_project_changes (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  first_changed_at timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  CHECK (last_changed_at >= first_changed_at AND due_at >= first_changed_at)
);
CREATE INDEX proactive_comparison_project_changes_due_idx
  ON proactive_comparison_project_changes(due_at, project_id);
ALTER TABLE proactive_comparison_outbox
  ADD COLUMN available_after timestamptz NOT NULL DEFAULT now();
CREATE INDEX proactive_comparison_outbox_ready_idx
  ON proactive_comparison_outbox(available_after, id) WHERE status = 'queued';
INSERT INTO flux_schema_version(version) VALUES (32) ON CONFLICT DO NOTHING;
