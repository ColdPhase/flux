-- Reverses 0116 (#228). Presence rows are transient; the slot is recomputed when people show presence again.
ALTER TABLE doc_live_presence DROP COLUMN IF EXISTS slot;
ALTER TABLE map_live_presence DROP COLUMN IF EXISTS slot;
