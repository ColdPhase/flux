-- #1352 (C-61): videos play inside Flux. `video_container` is what the first bytes of a video upload were recognised as (an MP4, WebM or MOV
-- container); it is set for a file of a plain space only (an encrypted space keeps a video an ordinary sealed file) and never from a name
-- alone. It marks the file as a video: its own cap, its own staging allowance, and the route that plays it. `poster_of` names the staged
-- video whose small poster picture this row is (taken by the sender's browser, re-encoded by the server): no foreign key, like a map
-- thought's image, so removing a video never deletes a poster row without queuing its object in `file_garbage`; a poster is attached to the
-- video's message (without a position of its own) and removed with it.
-- An ordinary file stays at 5 MiB in the database too: only a video may reserve or hold up to 1 GiB (the operator's cap is at most 1,024 MiB).
-- Works on data left by v0.2.0: two new nullable columns, and checks that only widen what a video row may hold; nothing to convert.
ALTER TABLE public.project_files
  ADD COLUMN video_container text CHECK (video_container = ANY (ARRAY['mp4', 'webm', 'mov'])),
  ADD COLUMN poster_of uuid;

CREATE INDEX project_files_poster_idx ON public.project_files (poster_of) WHERE poster_of IS NOT NULL;

ALTER TABLE public.project_files
  DROP CONSTRAINT project_files_check,
  DROP CONSTRAINT project_files_size_check,
  DROP CONSTRAINT project_file_publication;

ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_check CHECK (
    reserved_bytes BETWEEN 0 AND (CASE WHEN video_container IS NULL THEN 5242880 ELSE 1073741824 END)
    AND (reserved_bytes > 0 OR replay_of IS NOT NULL)),
  ADD CONSTRAINT project_files_size_check CHECK (size >= 1 AND size <= (CASE WHEN video_container IS NULL THEN 5242880 ELSE 1073741824 END)),
  ADD CONSTRAINT project_file_publication CHECK (
    (((message_id IS NULL) = ("position" IS NULL)) OR (poster_of IS NOT NULL AND message_id IS NOT NULL AND "position" IS NULL))
    AND (num_nonnulls(message_id, thought_id) <= 1)
    AND ((num_nonnulls(message_id, thought_id) = 1) = (published_at IS NOT NULL)));
