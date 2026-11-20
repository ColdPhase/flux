-- #1549 (C-61): a file other than a video may be as large as the operator's FLUX_FILE_MAX_MIB (1 to 1,024 MiB, 25 by default), streamed like a
-- video. The database cannot read the setting, so it holds every stored file to the setting's top (1 GiB, the same bound a video already had)
-- and the application holds each file to the operator's cap, a picture and every file of an encrypted space to 5 MiB.
-- v0.2.1 data: only the two checks change, and they only widen what a row may hold (every existing row is at most 5 MiB or a video up to
-- 1 GiB), so no row is converted. Adding a check reads the table once under its lock; project_files holds one row per file.
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.project_files
  DROP CONSTRAINT project_files_check,
  DROP CONSTRAINT project_files_size_check;

ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_check CHECK (reserved_bytes BETWEEN 0 AND 1073741824 AND (reserved_bytes > 0 OR replay_of IS NOT NULL)),
  ADD CONSTRAINT project_files_size_check CHECK (size >= 1 AND size <= 1073741824);
