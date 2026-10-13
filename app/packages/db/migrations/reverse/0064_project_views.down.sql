-- Fixture/manual pre-use reversal, under an explicit transaction and matching image/backup.
-- Legacy projects expose every view; intentional narrower choices must not be discarded.
LOCK TABLE projects IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM projects p WHERE
    ARRAY(SELECT DISTINCT view FROM unnest(p.views) AS view ORDER BY view)
      IS DISTINCT FROM ARRAY['agents','docs','map']::text[]) THEN
    RAISE EXCEPTION 'Cannot reverse 0064 while an intentional project view choice remains';
  END IF;
END $$;
ALTER TABLE projects DROP COLUMN views;
