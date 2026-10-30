-- F-030 encrypted workspaces, S3 (#655): why the key last changed. A rotation's `rotation_reason` (removed, demoted or
-- holder_deleted, with the person's id) is cleared at the finish; the finish now keeps it here, so People can say
-- "New key since 23 Oct, after Ben left." after the rotation. Ids and a kind only, like `rotation_reason`.
-- Numbered 0133: 0131 and 0132 are taken by #751.
ALTER TABLE workspace_keys ADD COLUMN key_change_reason jsonb
  CHECK (key_change_reason IS NULL OR jsonb_typeof(key_change_reason) = 'object');
