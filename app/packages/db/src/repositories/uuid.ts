const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statements that cast a value to `uuid` are only sent for one; PostgreSQL would raise an error for anything else. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
