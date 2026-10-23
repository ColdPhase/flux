-- F-029 follow-up (#642). docs/product/workspace-ai-lock.md, "AI origin".
--  * `notifications.ai_origin`: whether the notification came from AI work, written by whoever creates the row
--    (the event's actor or the item's author for generated ones; the assistant for its own). The lock reads this
--    column instead of guessing from labels. The default only keeps old raw inserts valid; every writer in the
--    application sets it explicitly.
--  * Backfill is conservative: anything that is plausibly AI-made is marked, so a pre-existing row can only be hidden
--    too often while AI is off, never delivered. Human rows stay false.
--  * Re-inserts the `allowed` row of any workspace 0115 missed (a workspace committed between its INSERT and the
--    trigger). The trigger covers every workspace created since; this statement is idempotent.
ALTER TABLE notifications ADD COLUMN ai_origin boolean NOT NULL DEFAULT false;

UPDATE notifications n SET ai_origin = true
WHERE n.assistant_join_request_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM events e WHERE e.id = n.event_id AND e.actor_id LIKE 'agent:%')
  OR EXISTS (SELECT 1 FROM events e JOIN project_messages m ON m.id::text = e.data->>'messageId'
    WHERE e.id = n.event_id AND m.author_agent_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM events e JOIN project_decisions d ON d.id::text = e.data->>'decisionId'
    WHERE e.id = n.event_id AND d.proposed_by_kind = 'agent')
  OR EXISTS (SELECT 1 FROM events e JOIN project_results r ON r.id::text = e.data->>'resultId'
    WHERE e.id = n.event_id AND r.created_by_kind = 'agent')
  OR (n.reason = 'review' AND n.body LIKE 'Your agent produced it%')
  OR EXISTS (SELECT 1 FROM assistant_reaction_notes a WHERE a.notification_id = n.id)
  OR n.title = 'Your assistant has a note for your task'
  OR n.title LIKE '%''s assistant suggests:%'
  OR n.title LIKE '%''s assistant asks to join'
  OR n.title LIKE '% would like to use their % plan here'
  OR n.title LIKE 'Paused %' AND n.body = 'Your assistant paused this schedule. Turn it on again when it is fixed.';

INSERT INTO workspace_ai_policies (workspace_id, state) SELECT id, 'allowed' FROM workspaces ON CONFLICT (workspace_id) DO NOTHING;
