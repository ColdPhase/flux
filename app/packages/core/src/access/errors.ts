/**
 * Domain errors carry the HTTP-neutral outcome of a policy or validation failure. Entry
 * points map `status` to their transport; `code` is stable and safe to show.
 */
export class DomainError extends Error {
  /** Extra safe fields merged into the error body, e.g. the latest authorized version. */
  details?: Record<string, unknown>;
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503, readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The object does not exist or the principal may not know that it exists. */
export class NotFoundError extends DomainError {
  constructor(what = 'Object', code = 'NOT_FOUND') {
    super(404, code, `${what} not found`);
  }
}

/** The principal can see the object but may not perform this action on it. */
export class ForbiddenError extends DomainError {
  constructor(message = 'Not allowed', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class InvalidInputError extends DomainError {
  constructor(message: string, code = 'INVALID_INPUT') {
    super(400, code, message);
  }
}

/** The request is well formed but breaks a domain rule (e.g. a cross-workspace link). */
export class RuleViolationError extends DomainError {
  constructor(message: string, code: string) {
    super(422, code, message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message);
  }
}

/** The request's content is larger than the limit (e.g. a staged file over 5 MiB). */
export class PayloadTooLargeError extends DomainError {
  constructor(message: string, code = 'PAYLOAD_TOO_LARGE') {
    super(413, code, message);
  }
}

/** An external dependency is required to enforce a security boundary safely. */
export class ServiceUnavailableError extends DomainError {
  constructor(message: string, code = 'SERVICE_UNAVAILABLE') {
    super(503, code, message);
  }
}

/**
 * The caller's expected version is stale. The change was not applied. `details` carries
 * the latest version and object the caller is authorized to read.
 */
export class VersionConflictError extends ConflictError {
  constructor(currentVersion: number, current: unknown) {
    super('The object changed since the expected version', 'VERSION_CONFLICT');
    this.details = { currentVersion, current };
  }
}

/** A versioned mutation arrived without an expected version (If-Match or expectedVersion). */
export class PreconditionRequiredError extends DomainError {
  constructor() {
    super(428, 'PRECONDITION_REQUIRED', 'This change needs the expected version in If-Match or expectedVersion');
  }
}

/**
 * Too many requests of one kind from one principal. `retryAfterSeconds` is safe to send
 * (entry points map it to HTTP 429 with `Retry-After`).
 */
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number, message: string, code: string) {
    super(429, code, message);
    this.details = { retryAfterSeconds };
  }
}
