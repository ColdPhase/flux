-- #179 / F-020 (PROV-1, PROV-3): an owner's AI connection may use any supported provider and model.
-- Relaxes the Anthropic-only pins of 0027 (O-007) and 0024 (O-008) without rewriting what they
-- recorded: every earlier connection stays anthropic/claude-sonnet-5 under its earlier consent, and
-- gets that model's dated table price. Sparse after 0041 (0035 is #166's and 0036 is #168's), and
-- independent of both. Custody (ciphertext, fingerprint, last four, revocation) is unchanged.
ALTER TABLE background_compute_connections
  DROP CONSTRAINT background_compute_connections_provider_check,
  DROP CONSTRAINT background_compute_connections_model_check,
  DROP CONSTRAINT background_compute_connections_consent_version_check,
  ADD CONSTRAINT background_compute_connections_provider_check
    CHECK (provider IN ('anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible')),
  -- The owner's choice within bounds: no spaces, controls or quotes.
  ADD CONSTRAINT background_compute_connections_model_check
    CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  ADD CONSTRAINT background_compute_connections_consent_version_check
    CHECK (consent_version IN ('o-007-2026-09-28', 'o-007-2026-10-02')),
  -- The 2026-09-28 disclosure named only this provider and model.
  ADD CONSTRAINT background_compute_connections_legacy_consent_check
    CHECK (consent_version <> 'o-007-2026-09-28' OR (provider = 'anthropic' AND model = 'claude-sonnet-5')),
  -- Owner-set for an OpenAI-compatible endpoint only; the named providers use their fixed public URL.
  ADD COLUMN base_url text,
  ADD CONSTRAINT background_compute_connections_base_url_check
    CHECK ((provider = 'openai_compatible') = (base_url IS NOT NULL)
      AND (base_url IS NULL OR (length(base_url) <= 2048 AND base_url ~ '^https?://[^[:space:]@?#]+$'))),
  -- Micro-dollars per 1M tokens. All null when no price is known: such a connection cannot be enabled.
  ADD COLUMN input_price_micros_per_mtok integer
    CHECK (input_price_micros_per_mtok BETWEEN 0 AND 1000000000),
  ADD COLUMN output_price_micros_per_mtok integer
    CHECK (output_price_micros_per_mtok BETWEEN 0 AND 1000000000),
  -- PROV-3: Flux's dated table or the owner; a provider-reported cost only reconciles a run's charge.
  ADD COLUMN price_source text CHECK (price_source IN ('table', 'owner')),
  ADD COLUMN price_checked_on date,
  ADD CONSTRAINT background_compute_connections_price_check
    CHECK ((input_price_micros_per_mtok IS NULL) = (price_source IS NULL)
      AND (output_price_micros_per_mtok IS NULL) = (price_source IS NULL)
      AND (price_checked_on IS NULL) = (price_source IS NULL OR price_source = 'owner'));

-- PROV-1: an owner may keep several connections. Each has a name, and the owner marks at most one
-- of them for background comparisons; the assistant's connection is the one its consent names
-- (personal_run_enablements.connection_id). Nothing falls back to another connection.
DROP INDEX background_compute_connections_active_owner_idx;
ALTER TABLE background_compute_connections
  ADD COLUMN name text NOT NULL DEFAULT 'Anthropic · claude-sonnet-5' CHECK (length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)),
  ADD COLUMN used_for_background boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT background_compute_connections_background_active_check CHECK (NOT used_for_background OR revoked_at IS NULL);
ALTER TABLE background_compute_connections ALTER COLUMN name DROP DEFAULT;
CREATE UNIQUE INDEX background_compute_connections_background_owner_idx
  ON background_compute_connections(owner_user_id) WHERE used_for_background;
-- The single connection an owner had before served background comparisons.
UPDATE background_compute_connections SET used_for_background = true WHERE revoked_at IS NULL;

-- O-007 recorded $2/M input and $10/M output for its pinned model on 2026-09-28.
UPDATE background_compute_connections
  SET input_price_micros_per_mtok = 2000000, output_price_micros_per_mtok = 10000000,
    price_source = 'table', price_checked_on = DATE '2026-09-28';

-- A consent names the connection's model, which may now be any id up to 200 characters.
ALTER TABLE personal_run_enablements
  DROP CONSTRAINT personal_run_enablements_consent_version_check,
  DROP CONSTRAINT personal_run_enablements_consent_provider_check,
  DROP CONSTRAINT personal_run_enablements_consent_model_check,
  ADD CONSTRAINT personal_run_enablements_consent_model_check CHECK (length(consent_model) BETWEEN 1 AND 200),
  ADD CONSTRAINT personal_run_enablements_consent_version_check
    CHECK (consent_version IN ('o-008-2026-09-28', 'o-008-2026-10-02')),
  ADD CONSTRAINT personal_run_enablements_consent_provider_check
    CHECK (consent_provider IN ('anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible')),
  ADD CONSTRAINT personal_run_enablements_legacy_consent_check
    CHECK (consent_version <> 'o-008-2026-09-28' OR consent_provider = 'anthropic');

-- The provider each run was sent to, for the answer's provenance (PROV-2). Earlier runs were Anthropic.
ALTER TABLE personal_runs
  ADD COLUMN provider text NOT NULL DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible'));
ALTER TABLE personal_runs ALTER COLUMN provider DROP DEFAULT;

-- A quiet comparison proposal names the provider and model it ran on, as the run's connection did.
-- Earlier proposals could only come from the O-007 pin.
ALTER TABLE proactive_comparison_proposals
  ADD COLUMN provider text NOT NULL DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai', 'openrouter', 'gemini', 'openai_compatible')),
  ADD COLUMN model text NOT NULL DEFAULT 'claude-sonnet-5'
    CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$');
ALTER TABLE proactive_comparison_proposals ALTER COLUMN provider DROP DEFAULT, ALTER COLUMN model DROP DEFAULT;
