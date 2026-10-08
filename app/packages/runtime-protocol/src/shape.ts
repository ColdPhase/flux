// A minimal, closed shape checker for the runtime protocol (F-022 AIM-3). Every message between the
// API/worker, the manager and a slot's supervisor is checked against an exact shape: unknown keys,
// wrong types, long strings and deep values are refused. Nothing is coerced.

export type Check<T> = (value: unknown) => value is T;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export const str = (pattern: RegExp, maxLength = 256): Check<string> =>
  (value): value is string => typeof value === 'string' && value.length <= maxLength && pattern.test(value);

/** Any text up to `maxLength` UTF-16 units without NUL; for prompts and briefs only. */
export const text = (maxLength: number, minLength = 0): Check<string> =>
  (value): value is string => typeof value === 'string' && value.length >= minLength && value.length <= maxLength && !value.includes('\u0000');

export const int = (min: number, max: number): Check<number> =>
  (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const bool: Check<boolean> = (value): value is boolean => typeof value === 'boolean';

export const oneOf = <const T extends readonly string[]>(values: T): Check<T[number]> =>
  (value): value is T[number] => typeof value === 'string' && (values as readonly string[]).includes(value);

export const literal = <const T extends string>(expected: T): Check<T> => (value): value is T => value === expected;

export const arrayOf = <T>(item: Check<T>, maxItems: number, minItems = 0): Check<T[]> =>
  (value): value is T[] => Array.isArray(value) && value.length >= minItems && value.length <= maxItems && value.every(item);

type Shape = Record<string, Check<unknown>>;
type Out<S extends Shape> = { [K in keyof S]: S[K] extends Check<infer T> ? T : never };

/**
 * An object with exactly the `required` keys, any of the `optional` keys and nothing else. An optional
 * key that is present must pass its check (`undefined` is not a value on the wire).
 */
export function object<R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O): Check<Out<R> & Partial<Out<O>>> {
  return (value): value is Out<R> & Partial<Out<O>> => {
    if (!plain(value)) return false;
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(required, key) && !(optional && Object.hasOwn(optional, key))) return false;
    }
    for (const [key, check] of Object.entries(required)) if (!Object.hasOwn(value, key) || !check(value[key])) return false;
    if (optional) for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(value, key) && !check(value[key])) return false;
    return true;
  };
}

/** The first key of `value` that `object(required, optional)` refuses, for a safe error message. */
export function firstBadKey(value: unknown, required: Shape, optional: Shape = {}): string | undefined {
  if (!plain(value)) return '(body)';
  for (const key of Object.keys(value)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) return key.slice(0, 64);
  for (const [key, check] of Object.entries(required)) if (!Object.hasOwn(value, key) || !check(value[key])) return key;
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(value, key) && !check(value[key])) return key;
  return undefined;
}

export const isPlainObject = plain;
