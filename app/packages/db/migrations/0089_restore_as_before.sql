-- Restoring a removed person brings them back as they were (founder decision, Hubert, 2026-11-15, #1424 F): their role (an Admin returns
-- as Admin), the spaces they were in with their role in each, and their direct messages. Removing a membership deletes its grants and its
-- DM places (the foreign keys cascade), so the removal keeps them on the person's row of the removed list first: `role`, the company or
-- encrypted space role they had, and `kept`, `{"spaces": [{"id", "role"}], "dms": [{"id", "joinedAt"}]}` (ids, roles and times, no
-- content). Restore puts back what still exists; joining again any other way clears the row with what it kept.
--
-- Works on the data of any release from v0.2.0 on: the people already on the list were removed before anything was kept, so they come
-- back as members with nothing more, as Restore did then.

ALTER TABLE public.workspace_removed_people ADD COLUMN role text NOT NULL DEFAULT 'member',
  ADD COLUMN kept jsonb NOT NULL DEFAULT '{"spaces": [], "dms": []}'::jsonb;
ALTER TABLE public.workspace_removed_people ALTER COLUMN role DROP DEFAULT, ALTER COLUMN kept DROP DEFAULT;
ALTER TABLE public.workspace_removed_people ADD CONSTRAINT workspace_removed_people_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'guest'::text]));
ALTER TABLE public.workspace_removed_people ADD CONSTRAINT workspace_removed_people_kept_check
  CHECK (jsonb_typeof(kept -> 'spaces') = 'array' AND jsonb_typeof(kept -> 'dms') = 'array');
