DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth_identity_audit WHERE old_issuer IS NOT NULL OR new_issuer IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0095 while issuer provenance is recorded in identity audit; export it first';
  END IF;
END $$;

ALTER TABLE auth_identity_audit DROP COLUMN old_issuer, DROP COLUMN new_issuer;
