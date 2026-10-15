-- #315 AC-3: record issuer provenance for new operator recovery actions. Older audit
-- rows have no trustworthy issuer value and intentionally remain NULL.
ALTER TABLE auth_identity_audit
  ADD COLUMN old_issuer text CHECK (old_issuer IS NULL OR length(old_issuer) BETWEEN 1 AND 2000),
  ADD COLUMN new_issuer text CHECK (new_issuer IS NULL OR length(new_issuer) BETWEEN 1 AND 2000);
