-- #1088: a sign-in or a password change that is already running with the old password must not survive a reset.
-- Better Auth checks the password against the hash it read and then creates the session (or writes the new hash) without looking again, so a
-- reset that commits in between left the session alive, or put the old password back.
-- Every password write bumps auth_accounts.password_version (here, in a trigger, so no path can forget it). The session insert and the
-- password change carry the version of the row whose hash a check accepted, in one statement, and the triggers refuse them under the row lock
-- unless the row still has that version. The carried value is a counter, never a password or a hash: a refused statement is quoted in the
-- error that drizzle throws, with its parameters.
--   auth_sessions.password_version_checked: on INSERT, refused unless the credential account is still at that version; cleared, not stored.
--   auth_accounts.password_version_expected: on UPDATE of the password, refused unless the row is still at that version; cleared, not stored.
--     A change that carries none (a reset) ends every session of the account in the same statement.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.auth_accounts ADD COLUMN password_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.auth_accounts ADD COLUMN password_version_expected integer;
ALTER TABLE public.auth_sessions ADD COLUMN password_version_checked integer;

CREATE FUNCTION public.auth_session_password_unchanged() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  -- FOR SHARE: a change of the password that comes in meanwhile waits for this insert to commit, and then deletes the session with the others.
  PERFORM 1 FROM auth_accounts a
    WHERE a.user_id = NEW.user_id AND a.provider_id = 'credential' AND a.password_version = NEW.password_version_checked
    FOR SHARE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'flux:password_changed: the password changed after it was checked' USING ERRCODE = 'P0001';
  END IF;
  NEW.password_version_checked := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_session_password_unchanged BEFORE INSERT ON public.auth_sessions
  FOR EACH ROW WHEN (NEW.password_version_checked IS NOT NULL) EXECUTE FUNCTION public.auth_session_password_unchanged();

CREATE FUNCTION public.auth_account_password_changed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  -- OLD is the row as it is now, after any update that held the lock first.
  IF NEW.password_version_expected IS NOT NULL AND OLD.password_version IS DISTINCT FROM NEW.password_version_expected THEN
    RAISE EXCEPTION 'flux:password_changed: the password changed after it was checked' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.password IS DISTINCT FROM OLD.password THEN
    NEW.password_version := OLD.password_version + 1;
    IF NEW.password_version_expected IS NULL AND NEW.provider_id = 'credential' THEN
      -- A password written with no check of the old one (a reset) ends every session, here, with the write. Better Auth deletes the sessions
      -- just before it writes, and a session created between the two (it saw the old version, and holds the share lock this write waited
      -- for) would otherwise stay.
      DELETE FROM auth_sessions WHERE user_id = NEW.user_id;
    END IF;
  END IF;
  NEW.password_version_expected := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_account_password_changed BEFORE UPDATE OF password, password_version_expected ON public.auth_accounts
  FOR EACH ROW WHEN (NEW.password_version_expected IS NOT NULL OR NEW.password IS DISTINCT FROM OLD.password)
  EXECUTE FUNCTION public.auth_account_password_changed();
