import { sql, type SQL } from 'drizzle-orm';
import { INVISIBLE_FORMAT_CLASS } from '@flux/contracts';

/**
 * A name a raw SQL select reads (a person's, an agent's), cleaned of direction controls and invisible format characters in the database, as the
 * schema's name columns are cleaned when they are read through it (#1347). The pattern goes as a parameter, so its characters are never SQL text.
 */
export const cleanName = (name: SQL) => sql`regexp_replace(${name}, ${INVISIBLE_FORMAT_CLASS}::text, '', 'g')`;
