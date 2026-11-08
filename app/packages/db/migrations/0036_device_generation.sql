-- #1031: a copy of the device cookie (#990) must stop counting as the person's browser after a password reset or "Sign out all other devices".
-- The cookie names an account by a keyed hash that includes this number; those two events raise it, so cookies given out before them no longer match.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.auth_users ADD COLUMN device_generation integer NOT NULL DEFAULT 0;
