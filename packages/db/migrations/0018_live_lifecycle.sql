-- An ending row is an admission fence committed before external DeleteRoom.
-- Keep transient presence as timing/state only; do not persist media identities.
ALTER TABLE live_sessions DROP CONSTRAINT live_sessions_state_check;
ALTER TABLE live_sessions ADD CONSTRAINT live_sessions_state_check
  CHECK (state IN ('available', 'rotating', 'ending', 'ended'));

ALTER TABLE live_sessions
  ADD COLUMN empty_since timestamptz,
  ADD COLUMN last_grant_at timestamptz,
  ADD COLUMN connected_once boolean NOT NULL DEFAULT false,
  ADD COLUMN ended_at timestamptz;

-- Existing available rooms must first be reconciled against the SFU. The
-- migration does not assume that a room with no Flux heartbeat is empty.
CREATE INDEX live_sessions_lifecycle_idx
  ON live_sessions(state, updated_at, id);

INSERT INTO flux_schema_version(version) VALUES (18) ON CONFLICT DO NOTHING;
