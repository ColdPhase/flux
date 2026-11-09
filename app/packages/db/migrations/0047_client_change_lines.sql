-- #868, mcp-cowork LC-2: a local client's task, Wiki page and map changes show their change line and Undo on the task, page or map
-- they are about. `scope_id` is that object: the task (also for a task it made), the page (also for a page it made), or the map (also
-- for a thought, link or move on it, whose own id is gone once it is deleted or undone). It is null for a change that belongs to no
-- such page: a message, a decision, a hand-off to another unit. Flux has no installs yet, so no earlier row is converted.
ALTER TABLE public.assistant_changes ADD COLUMN scope_id uuid;
CREATE INDEX assistant_changes_scope_idx ON public.assistant_changes USING btree (project_id, scope_id, created_at) WHERE (scope_id IS NOT NULL);
