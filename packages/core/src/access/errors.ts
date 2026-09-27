/**
 * Domain errors carry the HTTP-neutral outcome of a policy or validation failure. Entry
 * points map `status` to their transport; `code` is stable and safe to show.
 */
export class DomainError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, readonly code: string, message: string) {
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
