-- F-027 A4 (#404): the owner's lane serves the owner's own requests before background runs (AST-6 "Queue").
-- `authority` is what started the run, in the words of the change log's receipts: the owner's request, or a stored
-- schedule or reaction of the owner (A8/A9 set the other two). A background run carries the short name the owner gave
-- it ("Morning summary") for the line "Finishing your Morning summary first. Yours starts next.".
ALTER TABLE personal_runs
  ADD COLUMN authority text NOT NULL DEFAULT 'owner_request' CHECK (authority IN ('owner_request', 'owner_schedule', 'owner_reaction')),
  ADD COLUMN background_label text CHECK (background_label IS NULL OR char_length(background_label) BETWEEN 1 AND 80),
  ADD CONSTRAINT personal_runs_authority_label_check CHECK ((authority = 'owner_request') = (background_label IS NULL));
DROP INDEX personal_runs_queued_idx;
CREATE INDEX personal_runs_queued_idx ON personal_runs((authority <> 'owner_request'), created_at, id) WHERE status = 'queued';
