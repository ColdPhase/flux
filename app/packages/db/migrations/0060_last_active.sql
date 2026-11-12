-- When a person was last active (#1225, C-58): the time of their signed-in session's last request or live stream, written at most once a minute,
-- and the person's own switch "Show when I was last active" (on by default). Turning the switch off erases the time, and nothing writes it while it
-- is off. Both columns are safe on a database v0.2.0 left: a nullable time, and a flag that every existing person has on.
ALTER TABLE public.auth_users ADD COLUMN last_active_at timestamp with time zone;
ALTER TABLE public.auth_users ADD COLUMN show_last_active boolean NOT NULL DEFAULT true;
