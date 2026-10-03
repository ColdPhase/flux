-- #154: explicit native contribution kinds on canonical task-discussion messages and durable native command
-- receipts. Existing rows are plain text and stay byte-identical: the default 'text' is their true kind, no
-- blocker/result/handoff kind, result reference, author, time or sequence is inferred or backfilled.
ALTER TABLE project_messages ADD COLUMN contribution_kind text NOT NULL DEFAULT 'text';
ALTER TABLE project_messages ADD COLUMN result_id uuid;
ALTER TABLE project_messages ADD CONSTRAINT project_message_contribution_kind
  CHECK (contribution_kind IN ('text', 'blocker', 'result', 'handoff'));
-- A result contribution names exactly one canonical result of the same workspace and project; nothing else may.
ALTER TABLE project_messages ADD CONSTRAINT project_message_result_reference
  CHECK ((contribution_kind = 'result') = (result_id IS NOT NULL));
ALTER TABLE project_messages ADD CONSTRAINT project_message_result_scope
  FOREIGN KEY (workspace_id, project_id, result_id) REFERENCES project_results(workspace_id, project_id, id);
CREATE INDEX project_messages_result_idx ON project_messages(result_id) WHERE result_id IS NOT NULL;

-- One receipt per real actor, project, operation and client command UUID. It retains the produced object and,
-- for a task change, the produced version, plus the contribution messages, so an exact replay returns the
-- original canonical outcome instead of executing again. Distinct from the #152 connection-command ledger.
CREATE TABLE native_command_receipts (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  actor_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('work.update', 'result.create')),
  client_command_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  work_id uuid,
  work_version integer CHECK (work_version IS NULL OR work_version >= 1),
  result_id uuid,
  message_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_kind, actor_id, operation, client_command_id),
  CHECK ((operation = 'work.update') = (work_id IS NOT NULL AND work_version IS NOT NULL AND result_id IS NULL)),
  CHECK ((operation = 'result.create') = (result_id IS NOT NULL AND work_id IS NULL AND work_version IS NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, work_id)
    REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, result_id)
    REFERENCES project_results(workspace_id, project_id, id) ON DELETE CASCADE
);
