-- Human live sessions are durable project records; media rooms are opaque and replaceable.
-- Anchors use nullable composite foreign keys so they cannot silently cross projects.
ALTER TABLE sketches ADD CONSTRAINT sketches_workspace_project_id_unique UNIQUE (workspace_id, project_id, id);

CREATE TABLE live_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid,
  work_id uuid,
  sketch_id uuid,
  created_by text NOT NULL REFERENCES auth_users(id),
  client_session_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'ended')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  room_id text NOT NULL UNIQUE CHECK (length(room_id) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by, client_session_id),
  UNIQUE (workspace_id, project_id, id),
  CHECK (num_nonnulls(conversation_id, work_id, sketch_id) = 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, conversation_id)
    REFERENCES project_conversations(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, work_id)
    REFERENCES project_work_items(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, sketch_id)
    REFERENCES sketches(workspace_id, project_id, id)
);
CREATE INDEX live_sessions_project_idx ON live_sessions(project_id, created_at DESC, id DESC);

-- Committed presentation references only. Text, titles, screenshots and transcripts stay
-- in their existing authorized Flux objects, never in this trace or media signaling.
CREATE TABLE live_presentations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  created_by text NOT NULL REFERENCES auth_users(id),
  client_event_id uuid NOT NULL,
  ref_type text NOT NULL CHECK (ref_type IN ('message', 'material', 'work', 'result', 'sketch')),
  ref_id uuid NOT NULL,
  ref_version integer NOT NULL CHECK (ref_version > 0),
  selected_thought_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, created_by, client_event_id),
  CHECK (ref_type = 'sketch' OR cardinality(selected_thought_ids) = 0),
  CHECK (cardinality(selected_thought_ids) <= 100),
  FOREIGN KEY (workspace_id, project_id, session_id)
    REFERENCES live_sessions(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX live_presentations_session_idx ON live_presentations(session_id, created_at, id);

INSERT INTO flux_schema_version(version) VALUES (13) ON CONFLICT DO NOTHING;
