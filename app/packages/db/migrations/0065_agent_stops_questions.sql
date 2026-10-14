-- #347 (F-026 S13, S14): a person stops an external agent's work on a task, and an agent asks a person a question
-- with ready-made answers. Additive: no existing row changes. Sparse after 0062 (0063 and 0064 belong to other work).
-- docs/product/mcp-cowork.md "Stop and questions".

-- One row per stop: who ended which agent's hold on which task, and how many unfinished co-work units ended with it.
-- The task, its owner and its units are changed by the same transaction through their own commands; this is the record.
CREATE TABLE agent_stops (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  stopped_by text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  units_stopped integer NOT NULL CHECK (units_stopped >= 0),
  stopped_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES project_work_items(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_stops_project_idx ON agent_stops (project_id, stopped_at DESC);

-- A question an agent asked in a project conversation. The question is the agent's ordinary message
-- (project_messages); this adds the options and the answer. Exactly one of option and free text answers it.
CREATE TABLE agent_questions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  task_id uuid,
  agent_id uuid NOT NULL,
  asked_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_option integer CHECK (answered_option BETWEEN 0 AND 3),
  answer_text text CHECK (char_length(answer_text) BETWEEN 1 AND 2000),
  answered_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  answer_message_id uuid,
  answered_at timestamptz,
  UNIQUE (message_id),
  FOREIGN KEY (workspace_id, project_id, conversation_id) REFERENCES project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, message_id) REFERENCES project_messages(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE,
  CHECK ((answered_at IS NULL) = (answer_text IS NULL)),
  CHECK (answered_option IS NULL OR answered_at IS NOT NULL)
);
CREATE INDEX agent_questions_project_idx ON agent_questions (project_id, created_at DESC);
