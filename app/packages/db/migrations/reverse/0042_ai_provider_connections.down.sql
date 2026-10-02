-- Guarded pre-use reversal of 0042 (#179). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. The previous schema can represent only Anthropic `claude-sonnet-5` connections,
-- runs and proposals under the 2026-09-28 consents, so this refuses (and changes nothing) once any other
-- connection, consent, run or proposal exists. After real use, preserve the upgraded data and recover from
-- the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM background_compute_connections
      WHERE provider <> 'anthropic' OR model <> 'claude-sonnet-5' OR consent_version <> 'o-007-2026-09-28') THEN
    RAISE EXCEPTION '0042 reversal refused: provider-neutral background connections exist' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM personal_run_enablements
      WHERE consent_provider <> 'anthropic' OR consent_version <> 'o-008-2026-09-28') THEN
    RAISE EXCEPTION '0042 reversal refused: provider-neutral personal-run consents exist' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM personal_runs WHERE provider <> 'anthropic')
    OR EXISTS (SELECT 1 FROM proactive_comparison_proposals WHERE provider <> 'anthropic' OR model <> 'claude-sonnet-5') THEN
    RAISE EXCEPTION '0042 reversal refused: runs or proposals of other providers exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
ALTER TABLE proactive_comparison_proposals DROP COLUMN model, DROP COLUMN provider;
ALTER TABLE personal_runs DROP COLUMN provider;
ALTER TABLE personal_run_enablements
  DROP CONSTRAINT personal_run_enablements_legacy_consent_check,
  DROP CONSTRAINT personal_run_enablements_consent_provider_check,
  DROP CONSTRAINT personal_run_enablements_consent_version_check,
  ADD CONSTRAINT personal_run_enablements_consent_provider_check CHECK (consent_provider = 'anthropic'),
  ADD CONSTRAINT personal_run_enablements_consent_version_check CHECK (consent_version = 'o-008-2026-09-28');
ALTER TABLE background_compute_connections
  DROP CONSTRAINT background_compute_connections_price_check,
  DROP COLUMN price_checked_on,
  DROP COLUMN price_source,
  DROP COLUMN output_price_micros_per_mtok,
  DROP COLUMN input_price_micros_per_mtok,
  DROP CONSTRAINT background_compute_connections_base_url_check,
  DROP COLUMN base_url,
  DROP CONSTRAINT background_compute_connections_legacy_consent_check,
  DROP CONSTRAINT background_compute_connections_consent_version_check,
  DROP CONSTRAINT background_compute_connections_model_check,
  DROP CONSTRAINT background_compute_connections_provider_check,
  ADD CONSTRAINT background_compute_connections_provider_check CHECK (provider = 'anthropic'),
  ADD CONSTRAINT background_compute_connections_model_check CHECK (model = 'claude-sonnet-5'),
  ADD CONSTRAINT background_compute_connections_consent_version_check CHECK (consent_version = 'o-007-2026-09-28');
