-- F-034 (#763 E1, founder decision 2026-10-30): decisions in the Wiki are live reference cards, never copied sections.
-- The API process converts the copied `## Decision:` sections of each doc once (apps/server/src/docs/decision-cards.ts)
-- and records it here: the version it read and, when it converted anything, the version it made. The copied text stays
-- in `from_version`, so a conversion can be reversed by restoring that version. Ids and numbers only, no content.
-- Sparse after 0134 (0133 belongs to other open work).
CREATE TABLE doc_decision_card_migrations (
  doc_id uuid PRIMARY KEY REFERENCES project_materials(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_version integer NOT NULL CHECK (from_version >= 1),
  to_version integer CHECK (to_version > from_version),
  converted integer NOT NULL DEFAULT 0 CHECK (converted >= 0),
  kept integer NOT NULL DEFAULT 0 CHECK (kept >= 0),
  done_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((converted = 0) = (to_version IS NULL))
);
