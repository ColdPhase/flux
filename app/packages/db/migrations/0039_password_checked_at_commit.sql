-- #1088: a sign-in or a password change that is already running with the old password must not survive a reset.
-- Better Auth checks the password against the hash it read and then creates the session (or writes the new hash) without looking again, so a
-- reset that commits in between left the session alive, or put the old password back. The two columns below only carry, for one statement, the
-- hash that a check accepted (the value auth_accounts.password already holds); the triggers compare it with the hash in the row, under the row
-- lock, in the same statement, and clear it before the row is stored, so nothing is kept:
--   auth_sessions.password_checked: on INSERT, the session is refused unless the credential account still has the hash that was accepted.
--   auth_accounts.password_expected: on UPDATE, the change is refused unless the row still has the hash that was accepted. A change that
--   carries none (a reset) ends every session of the account in the same statement.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.auth_sessions ADD COLUMN password_checked text;
ALTER TABLE public.auth_accounts ADD COLUMN password_expected text;

CREATE FUNCTION public.auth_session_password_unchanged() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.password_checked IS NOT NULL THEN
    -- FOR SHARE: a change of the password that comes in meanwhile waits for this insert to commit, and then deletes the session with the others.
    PERFORM 1 FROM auth_accounts a
      WHERE a.user_id = NEW.user_id AND a.provider_id = 'credential'
        AND a.password = NEW.password_checked
      FOR SHARE OF a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'flux:password_changed: the password changed after it was checked' USING ERRCODE = 'P0001';
    END IF;
    NEW.password_checked := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_session_password_unchanged BEFORE INSERT ON public.auth_sessions
  FOR EACH ROW WHEN (NEW.password_checked IS NOT NULL) EXECUTE FUNCTION public.auth_session_password_unchanged();

CREATE FUNCTION public.auth_account_password_changed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.password_expected IS NOT NULL THEN
    -- OLD is the row as it is now, after any update that held the lock first.
    IF OLD.password IS DISTINCT FROM NEW.password_expected THEN
      RAISE EXCEPTION 'flux:password_changed: the password changed after it was checked' USING ERRCODE = 'P0001';
    END IF;
    NEW.password_expected := NULL;
  ELSIF NEW.provider_id = 'credential' THEN
    -- A password written with no check of the old one (a reset) ends every session, here, with the write. Better Auth deletes the sessions
    -- just before it writes, and a session created between the two (it saw the old hash, and holds the share lock this write waited for)
    -- would otherwise stay.
    DELETE FROM auth_sessions WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_account_password_changed BEFORE UPDATE OF password, password_expected ON public.auth_accounts
  FOR EACH ROW WHEN (NEW.password_expected IS NOT NULL OR NEW.password IS DISTINCT FROM OLD.password)
  EXECUTE FUNCTION public.auth_account_password_changed();
