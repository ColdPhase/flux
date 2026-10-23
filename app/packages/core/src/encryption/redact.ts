/**
 * Error text can quote content (F-030 Error paths). Whenever work concerns a sealed workspace, `redactedError` replaces
 * an error everywhere it is stored or logged. It keeps the error class, the domain code, the PostgreSQL SQLSTATE and
 * constraint name and the given ids, never the message, `detail` or stack.
 */
export interface RedactedError {
  name: string;
  code: string | null;
  sqlState: string | null;
  constraint: string | null;
  ids: string[];
  /** A message made only of the fields above. */
  message: string;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const CONSTRAINT = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactedError(error: unknown, ids: readonly string[] = []): RedactedError {
  const value = (error ?? {}) as { name?: unknown; code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const name = typeof value.name === 'string' && SAFE_NAME.test(value.name) ? value.name : 'Error';
  const rawCode = value.code ?? value.cause?.code;
  const sqlState = typeof rawCode === 'string' && SQLSTATE.test(rawCode) ? rawCode : null;
  const code = typeof value.code === 'string' && SAFE_CODE.test(value.code) && !sqlState ? value.code : null;
  const rawConstraint = value.constraint ?? value.cause?.constraint;
  const constraint = typeof rawConstraint === 'string' && CONSTRAINT.test(rawConstraint) ? rawConstraint : null;
  const safeIds = ids.filter((id) => UUID.test(id));
  const message = [name, code, sqlState && `SQLSTATE ${sqlState}`, constraint && `constraint ${constraint}`, safeIds.length ? `ids ${safeIds.join(',')}` : null]
    .filter(Boolean).join(' · ');
  return { name, code, sqlState, constraint, ids: safeIds, message };
}

/** What a worker handler throws for a sealed workspace's job, so pg-boss stores only the code. */
export class SealedJobError extends Error {
  constructor(readonly code: string) {
    super(SAFE_CODE.test(code) ? code : 'SEALED_JOB_FAILED');
    this.name = 'SealedJobError';
  }
}
