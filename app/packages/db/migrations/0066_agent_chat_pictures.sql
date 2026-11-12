-- Pictures in an agent's private chat (#1217, founder decision 2026-11-12, AG-8, C-59).
--
-- A picture an agent attaches to its answer in its private chat belongs to no space, so it is no project file: it is the run's own,
-- readable by the run's owner alone, its bytes in the same files volume under its id. It goes with its run (and its bytes to the durable
-- deletion queue, as a deleted message's files do). Works on data left by v0.2.0: a new table and its trigger.
CREATE TABLE public.personal_run_pictures (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    name text NOT NULL,
    size integer NOT NULL,
    sha256 text NOT NULL,
    "position" smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_run_pictures_pkey PRIMARY KEY (id),
    CONSTRAINT personal_run_pictures_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE,
    CONSTRAINT personal_run_pictures_owner_fkey FOREIGN KEY (owner_user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE,
    CONSTRAINT personal_run_pictures_position UNIQUE (run_id, "position"),
    CONSTRAINT personal_run_pictures_name_check CHECK (char_length(name) >= 1 AND char_length(name) <= 200),
    CONSTRAINT personal_run_pictures_size_check CHECK (size >= 1 AND size <= 5242880),
    CONSTRAINT personal_run_pictures_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT personal_run_pictures_position_check CHECK ("position" >= 0 AND "position" <= 9)
);
CREATE FUNCTION public.personal_run_pictures_gone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO file_garbage (id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_pictures_gone AFTER DELETE ON public.personal_run_pictures FOR EACH ROW
  EXECUTE FUNCTION public.personal_run_pictures_gone();
