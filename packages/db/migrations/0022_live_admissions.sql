-- Media admission bound to the authentication session that asked for it (#128). A
-- LiveKit grant carries only the opaque admission id as participant metadata, and SFU
-- refreshes keep it. The Flux signaling gate accepts that grant only while the row is
-- unrevoked and the request's own cookie session is this auth_session_id.
CREATE TABLE live_admissions (
  -- 128 random bits, base64url without padding.
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  live_session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  -- No foreign key: the row outlives its session as a revoked record, so the SFU
  -- participant still carrying this id can be found and removed.
  auth_session_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX live_admissions_auth_session_idx ON live_admissions(auth_session_id) WHERE revoked_at IS NULL;
CREATE INDEX live_admissions_session_idx ON live_admissions(live_session_id, user_id, issued_at DESC);
CREATE INDEX live_admissions_revoked_idx ON live_admissions(revoked_at) WHERE revoked_at IS NOT NULL;

-- Every way a session ends deletes its row: Better Auth sign-out and password reset,
-- Flux's own session revocation, expiry cleanup and user deletion (cascade). Revoking
-- here commits with the deletion itself; the notification only wakes the API to close
-- sockets and remove SFU participants, and a periodic pass repeats that work.
CREATE FUNCTION flux_revoke_live_admissions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE live_admissions SET revoked_at = now()
  WHERE auth_session_id = OLD.id AND revoked_at IS NULL;
  IF FOUND THEN
    PERFORM pg_notify('flux_live_admissions', OLD.id);
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER auth_sessions_revoke_live_admissions
  AFTER DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION flux_revoke_live_admissions();

INSERT INTO flux_schema_version(version) VALUES (22) ON CONFLICT DO NOTHING;
