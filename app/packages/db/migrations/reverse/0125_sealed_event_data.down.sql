-- Reversal of 0125 (F-030 S2a-2c-3, #655). Not applied by the migrator.
ALTER TABLE sealed_job_waits DROP COLUMN attempts;
DROP TRIGGER a_sealed_event_audience ON event_audience;
DROP FUNCTION flux_event_audience_shape();
DROP TRIGGER a_sealed_wait_ids_only ON sealed_job_waits;
DROP FUNCTION flux_sealed_wait_ids_only();
DROP TRIGGER a_sealed_event_data ON events;
DROP FUNCTION flux_event_data_free();
DROP TABLE event_data_tokens;
DROP TABLE event_data_keys;
