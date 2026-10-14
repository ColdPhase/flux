-- "Needs you" (#342, F-026 S1/S11): what a person did with an item of their Inbox queue. The queue itself
-- is computed from current rows; only these per-person choices are stored. `item_key` names the need
-- (`decision:<id>`, `blocked:<id>`, `note:<notification id>`). A snooze ends at `until`, or when the task
-- `until_work_id` is finished. Sparse: 0060-0062 are reserved by open branches.
CREATE TABLE needs_you_states (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('done', 'declined', 'snoozed')),
  until timestamptz,
  until_work_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key),
  CHECK (state = 'snoozed' OR (until IS NULL AND until_work_id IS NULL)),
  CHECK (state <> 'snoozed' OR (until IS NOT NULL) <> (until_work_id IS NOT NULL))
);
