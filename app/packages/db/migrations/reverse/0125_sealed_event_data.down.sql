-- Reversal of 0125 (F-030 S2a-2c-3, #655). Not applied by the migrator.
DROP TRIGGER a_sealed_event_data ON events;
DROP FUNCTION flux_event_data_free();
DROP TABLE event_data_tokens;
