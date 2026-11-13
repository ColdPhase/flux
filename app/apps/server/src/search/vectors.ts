import { createEmbedder, createQueryVectors, QUERY_EMBED_TIMEOUT_MS, type EmbeddingsConfig } from '@flux/core';
import type { QueryVectors } from '@flux/db';

/**
 * The query-vector hook of ranked search (F-042, #1294), or undefined while the optional embedding container is off: then nothing
 * about search changes. Create it once in the composition root and give it to every ranked search of the process; it keeps the
 * cool-down that stops searches waiting for a container that is down.
 */
export function searchQueryVectors(config: EmbeddingsConfig): QueryVectors | undefined {
  return config.status === 'on' ? createQueryVectors(createEmbedder(config.url, { timeoutMs: QUERY_EMBED_TIMEOUT_MS })) : undefined;
}
