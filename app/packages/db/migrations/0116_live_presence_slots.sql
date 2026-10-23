-- #228: a per-room slot for each person showing live presence. The server hands the smallest free slot to a person
-- when they first appear in a map or wiki room and keeps it while they stay, so every viewer draws the same shape for
-- the same person (shape = slot mod 4) and an existing person's shape never changes when someone joins.
ALTER TABLE map_live_presence ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 0 CHECK (slot >= 0 AND slot < 128);
ALTER TABLE doc_live_presence ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 0 CHECK (slot >= 0 AND slot < 128);
