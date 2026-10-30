-- Reversal of 0124 (F-030 S2a-2c, #655). Not applied by the migrator.
DROP TRIGGER z_notification_content_free ON notifications;
DROP FUNCTION flux_notification_content_free();
