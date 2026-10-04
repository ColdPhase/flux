// JSON schema fragments shared by `/api/v1` routes (#85).

/** A name or title: 1–200 characters. */
export const nameSchema = { type: 'string', minLength: 1, maxLength: 200 } as const;
/** A positive object version (If-Match / expectedVersion). */
export const versionSchema = { type: 'integer', minimum: 1 } as const;
/** `?limit=&offset=` paging. */
export const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer' }, offset: { type: 'integer' } },
} as const;
