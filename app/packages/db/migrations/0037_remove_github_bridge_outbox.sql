-- The GitHub bridge outbox goes (#1032, #479): since #973 nothing reads it (its only reader was the coordination inbox), and nothing
-- ever pruned it. An agent that holds a task reads the current state of its linked pull request itself, through the task.
-- There is no existing data to keep.
DROP TABLE public.github_bridge_outbox;
