/**
 * What `flux_summarize` returns in one answer (F-042, AG-12, #1292): the messages of a conversation, a thread, a task's discussion, a
 * space or a direct message in a time range, as one compact digest the agent summarises itself. A long range is read in answers of this
 * size, so that each stays well inside a run's input bound (an API-key run sends at most 64,000 tokens with its tools): about 4,000 tokens
 * of digest, and no single message takes more than a thirtieth of it. The tool says when it stopped early and how to go on.
 */
export const AGENT_SUMMARY_LIMITS = { pageChars: 16_000, messageChars: 500, pageMessages: 400 } as const;
