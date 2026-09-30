import { SKETCH_LIMITS, THOUGHT_SHAPES, type PageQuery, type ThoughtShape } from '@flux/contracts';
import { InvalidInputError, PreconditionRequiredError } from '../access/errors.js';

// Input rules of the sketch use cases. Entry points may validate the shape of a request
// earlier, but these checks are the ones every entry point (HTTP, later MCP) shares.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function id(value: unknown, field: string): string {
  if (!isId(value)) throw new InvalidInputError(`${field} must be a UUID`);
  return value.toLowerCase();
}

/** A list of distinct UUIDs (1–max), lower-cased. */
export function ids(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new InvalidInputError(`${field} must list 1–${max} ids`);
  const list = value.map((item, index) => id(item, `${field}[${index}]`));
  if (new Set(list).size !== list.length) throw new InvalidInputError(`Each id may appear once in ${field}`);
  return list;
}

export function optionalId(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : id(value, field);
}

export function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > max) throw new InvalidInputError(`${field} must be 1–${max} characters`);
  return trimmed;
}

export function label(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidInputError('label must be a string or null');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > SKETCH_LIMITS.label) throw new InvalidInputError(`label must be at most ${SKETCH_LIMITS.label} characters`);
  return trimmed;
}

function integerIn(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidInputError(`${field} must be a number`);
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) throw new InvalidInputError(`${field} must be between ${min} and ${max}`);
  return rounded;
}

export const coordinate = (value: unknown, field: string) => integerIn(value, field, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate);
export const width = (value: unknown) => integerIn(value, 'width', SKETCH_LIMITS.minWidth, SKETCH_LIMITS.maxWidth);
export const height = (value: unknown) => integerIn(value, 'height', SKETCH_LIMITS.minHeight, SKETCH_LIMITS.maxHeight);

export function shape(value: unknown): ThoughtShape {
  if (typeof value !== 'string' || !THOUGHT_SHAPES.includes(value as ThoughtShape)) throw new InvalidInputError(`shape must be one of ${THOUGHT_SHAPES.join(', ')}`);
  return value as ThoughtShape;
}

/** The caller's expected version (If-Match or body). Checked only after authorization, so it never reveals an object. */
export function expectedVersion(value: unknown): number {
  if (value === undefined || value === null) throw new PreconditionRequiredError();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
  return value;
}

export function page(query: PageQuery = {}): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}
