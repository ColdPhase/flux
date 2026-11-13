-- "Hide previews" in Settings › Notifications (founder decision, Hubert, 2026-11-13, #1346): with it on, a push says only who and where
-- ("Ada mentioned you in Tool library"), never what was written. Off by default, like Slack and WhatsApp; rows left by v0.2.0 take the default.
ALTER TABLE public.notification_preferences ADD COLUMN hide_previews boolean NOT NULL DEFAULT false;
