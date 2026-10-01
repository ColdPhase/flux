-- Return points (#106, foundation 8.8): where each person last looked at a place.
-- A point is a position in the person's own event_audience rows (an event seq), never sent to
-- clients. Home is one place per person; a project or conversation point names the place and
-- disappears with it. `previous_seq` lets the person move the point back once ("keep for later").
CREATE TABLE return_points (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  place_key text NOT NULL,
  place_type text NOT NULL CHECK (place_type IN ('home', 'project', 'conversation')),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES project_conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq >= 0),
  saved_at timestamptz NOT NULL DEFAULT now(),
  previous_seq bigint CHECK (previous_seq IS NULL OR previous_seq >= 0),
  previous_saved_at timestamptz,
  PRIMARY KEY (user_id, place_key),
  CHECK ((previous_seq IS NULL) = (previous_saved_at IS NULL)),
  CHECK ((place_type = 'home') = (project_id IS NULL)),
  CHECK ((place_type = 'conversation') = (conversation_id IS NOT NULL)),
  CHECK (place_key = CASE place_type WHEN 'home' THEN 'home'
    WHEN 'project' THEN 'project:' || project_id::text
    ELSE 'conversation:' || conversation_id::text END)
);
CREATE INDEX return_points_project_idx ON return_points(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX return_points_conversation_idx ON return_points(conversation_id) WHERE conversation_id IS NOT NULL;

INSERT INTO flux_schema_version(version) VALUES (9) ON CONFLICT DO NOTHING;
