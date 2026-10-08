# Legacy migration controls

These SQL fixtures are byte-identical copies of the historical artifacts, used
only in isolated PostgreSQL databases by the semantic migration gate regression.
They are not files in the shipped migration manifest and are never applied to a
shared database.

- `0057_notification_pause.sql`: committed `d972f2fa`, focus-57.
- `0048_unused_ai_task_creation_undo.sql` and `0057_task_creation_undo_grant.sql`:
  `0c3970401173080e83140e62654cd6c1b31994d0`, Undo facts-48 / grant-57.

The test-only checkpoint is a negative control against the prior migrator. It
has not been executed until its explicit Docker verification window. Original
worktrees, databases and services remain untouched.
