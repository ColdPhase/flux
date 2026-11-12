-- A person's profile photo (F-039, #1226): one row per person who has one. `id` is the photo's version, the random id in its
-- immutable URL; a new photo is a new row with a new id. The three WebP renditions are objects in the files volume, named by
-- the three object ids. Deleting the row, by a new photo, by "Remove photo" or with the account, queues those objects for
-- physical deletion in `file_garbage`, as a deleted attachment is. Works on data left by v0.2.0: nobody has a photo yet.
CREATE TABLE public.person_photos (
    id uuid NOT NULL,
    user_id text NOT NULL,
    object_64 uuid NOT NULL,
    object_128 uuid NOT NULL,
    object_256 uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT person_photos_pkey PRIMARY KEY (id),
    CONSTRAINT person_photos_user_id_key UNIQUE (user_id),
    CONSTRAINT person_photos_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE
);

CREATE FUNCTION public.flux_person_photo_garbage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO public.file_garbage (id) VALUES (old.object_64), (old.object_128), (old.object_256) ON CONFLICT DO NOTHING;
  RETURN old;
END;
$$;

CREATE TRIGGER person_photo_garbage AFTER DELETE ON public.person_photos FOR EACH ROW EXECUTE FUNCTION public.flux_person_photo_garbage();
