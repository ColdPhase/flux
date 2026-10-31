-- F-034 (#763 E1, founder decision 2026-10-30): decisions in the Wiki are live reference cards, never copied sections.
-- The API process converts the copied `## Decision:` sections of each doc once (apps/server/src/docs/decision-cards.ts)
-- and records it here: the version it read and, when it converted anything, the version it made. The copied text stays
-- in `from_version`; `restoreDecisionCards` brings it back as a new version while the doc is still at `to_version`, and
-- sets `restored_version` so the sweep never converts that doc again. Ids and numbers only, no content.
-- Sparse after 0134 (0133 belongs to other open work).
CREATE TABLE doc_decision_card_migrations (
  doc_id uuid PRIMARY KEY REFERENCES project_materials(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_version integer NOT NULL CHECK (from_version >= 1),
  to_version integer CHECK (to_version > from_version),
  converted integer NOT NULL DEFAULT 0 CHECK (converted >= 0),
  kept integer NOT NULL DEFAULT 0 CHECK (kept >= 0),
  restored_version integer CHECK (restored_version > to_version),
  done_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((converted = 0) = (to_version IS NULL))
);

-- A doc whose conversion failed (other than a locked encrypted workspace, which simply waits): the error code only,
-- never text. The sweep waits until `retry_after` (doubling from 10 minutes); the same code five times in a row stops
-- the retries (`retry_after = 'infinity'`) until an operator deletes the row.
CREATE TABLE doc_decision_card_failures (
  doc_id uuid PRIMARY KEY REFERENCES project_materials(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_]{1,64}$'),
  attempts integer NOT NULL CHECK (attempts >= 1),
  retry_after timestamptz NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
