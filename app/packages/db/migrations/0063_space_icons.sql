-- A space's icon (F-040, #1227): an emoji or a picture in its tile, one row per space that has one; no row keeps its letter. A picture's
-- `picture` is its version, the random id in its immutable URL, and its three WebP renditions are objects in the files volume. A
-- deleted row (a new icon, "Use the letter", or the space going) queues its objects in `file_garbage`, as a profile photo does. An
-- encrypted space keeps its letter: like GitHub, the table refuses a row of an encrypted workspace (`a_sealed_workspace_refused`), so
-- no unsealed icon of one is ever stored. Works on data left by v0.2.0: no space has an icon yet.
CREATE TABLE public.space_icons (
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    emoji text,
    picture uuid,
    object_64 uuid,
    object_128 uuid,
    object_256 uuid,
    changed_by text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT space_icons_pkey PRIMARY KEY (project_id),
    CONSTRAINT space_icons_picture_key UNIQUE (picture),
    CONSTRAINT space_icons_project_fkey FOREIGN KEY (workspace_id, project_id) REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT space_icons_one_kind CHECK (
      (emoji IS NOT NULL AND char_length(emoji) BETWEEN 1 AND 32 AND picture IS NULL AND object_64 IS NULL AND object_128 IS NULL AND object_256 IS NULL)
      OR (emoji IS NULL AND picture IS NOT NULL AND object_64 IS NOT NULL AND object_128 IS NOT NULL AND object_256 IS NOT NULL))
);

CREATE TRIGGER a_sealed_workspace_refused BEFORE INSERT ON public.space_icons FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_refused();

-- The refusal names no feature: GitHub and space icons share it.
CREATE OR REPLACE FUNCTION public.sealed_workspace_refused() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE
  r jsonb := to_jsonb(NEW);
  uuid_text text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ws uuid;
BEGIN
  IF coalesce(r ->> 'workspace_id', '') ~* uuid_text THEN
    ws := (r ->> 'workspace_id')::uuid;
  ELSIF coalesce(r ->> 'project_id', '') ~* uuid_text THEN
    SELECT workspace_id INTO ws FROM projects WHERE id = (r ->> 'project_id')::uuid;
  END IF;
  IF ws IS NOT NULL AND workspace_sealed(ws) THEN
    RAISE EXCEPTION 'This is not available in an encrypted workspace' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTED_UNSUPPORTED';
  END IF;
  RETURN NEW;
END $_$;

CREATE FUNCTION public.flux_space_icon_garbage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF old.picture IS NOT NULL THEN
    INSERT INTO public.file_garbage (id) VALUES (old.object_64), (old.object_128), (old.object_256) ON CONFLICT DO NOTHING;
  END IF;
  RETURN old;
END;
$$;

CREATE TRIGGER space_icon_garbage AFTER DELETE ON public.space_icons FOR EACH ROW EXECUTE FUNCTION public.flux_space_icon_garbage();
