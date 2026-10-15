-- Reversal of 0063 (#342). Not applied by the migrator and never edits the schema ledger. It forgets
-- only which items a person marked done, declined or put off; the queue is computed from other rows.
DROP TABLE needs_you_states;
