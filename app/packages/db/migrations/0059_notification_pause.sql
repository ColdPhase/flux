-- Focus mode (#340, F-026 S19): push and email wait until paused_until; the Inbox still fills. Null
-- means nothing is paused. Adding a nullable column changes no existing row's behaviour.
ALTER TABLE notification_preferences ADD COLUMN paused_until timestamptz;
