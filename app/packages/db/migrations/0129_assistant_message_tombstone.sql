-- #68 closeout (founder direction 2026-10-29): Undo also takes back the assistant's own posted message. A message keeps its place
-- in the conversation (its sequence, its thread, the ids that events and notices carry), so Undo does not delete the row: it
-- replaces the text with a fixed marker and records when. Only the assistant's Undo writes it, and only for a message the assistant
-- posted that nobody has answered, cited or used since; the audit row is the assistant_changes row of the Undo. A map, a recorded
-- result and a proposed decision that nobody used are removed outright by the same Undo, which needs no column.
ALTER TABLE project_messages ADD COLUMN removed_at timestamptz;
