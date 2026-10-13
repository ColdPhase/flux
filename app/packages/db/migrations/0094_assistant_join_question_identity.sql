-- #402 / #457: immutable public identity for each assistant join-request opening.
CREATE TABLE assistant_join_question_identity_snapshots (
  join_request_id uuid NOT NULL,
  opening_version integer NOT NULL CHECK (opening_version > 0),
  assistant_id uuid NOT NULL,
  assistant_name text NOT NULL,
  owner_id text NOT NULL,
  owner_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notification_linked_at timestamptz,
  PRIMARY KEY (join_request_id, opening_version)
);

ALTER TABLE notifications
  ADD COLUMN assistant_join_request_id uuid,
  ADD COLUMN assistant_join_opening_version integer,
  ADD CONSTRAINT notifications_assistant_join_identity_pair_check CHECK (
    (assistant_join_request_id IS NULL) = (assistant_join_opening_version IS NULL)
  ),
  ADD CONSTRAINT notifications_assistant_join_identity_snapshot_fk
    FOREIGN KEY (assistant_join_request_id, assistant_join_opening_version)
    REFERENCES assistant_join_question_identity_snapshots (join_request_id, opening_version);
