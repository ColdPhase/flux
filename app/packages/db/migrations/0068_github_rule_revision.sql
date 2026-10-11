-- #74: a rule's revision, the compare-and-set token for a manual override. It starts at 1 and grows on every
-- semantic change of the rule (turned on or off, mode, resume, suspension, an automatic task change). Additive.
ALTER TABLE github_task_rules ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
