-- Two sound switches in Settings › Notifications (founder decision, Hubert, 2026-11-12, #1243): "Sound for messages" (direct messages,
-- mentions and questions to you), off by default, and "Sound when someone calls me" (the single soft chime of a direct call invitation),
-- on by default. Both follow the level and quiet hours, because an open tab plays them only with a notice. Rows left by v0.2.0 take the
-- defaults.
ALTER TABLE public.notification_preferences ADD COLUMN sound_messages boolean NOT NULL DEFAULT false;
ALTER TABLE public.notification_preferences ADD COLUMN sound_calls boolean NOT NULL DEFAULT true;
