-- An agent attaches a file it made or wrote to its answer (#1437, RT-5, AG-8; coordinator decision 2026-11-13): the change log names it as a
-- file, its own object type, not a picture. The file itself is an ordinary stored file staged for the asker (or, in the agent's private chat,
-- a file of the run's own, `personal_run_pictures`). Works on data left by v0.2.0: it widens a CHECK.
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_object_type_check;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_object_type_check
  CHECK (object_type = ANY (ARRAY['work'::text, 'doc'::text, 'map'::text, 'thought'::text, 'link'::text, 'message'::text, 'decision'::text, 'picture'::text, 'file'::text]));
