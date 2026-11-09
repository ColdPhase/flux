import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** Freezes a converted JSON Schema down to its leaves: it is shared by every request, so none may change it for the next. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) frozen(member);
  }
  return value;
}

/**
 * A tool's input schema as the SDK takes it, built once for the whole process. Zod still validates every call, exactly as before;
 * what changes is the JSON Schema the SDK asks for to list the tool and to read the called tool's declarations: it is converted the
 * first time (with the options the SDK asked with) and handed out as it was every time after, frozen. Zod's own conversion is the
 * most expensive part of a request that lists tools, and a schema never changes once its tool is defined.
 */
export function convertedOnce<S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const standard = schema['~standard'];
  const converted = new Map<string, Record<string, unknown>>();
  const once = (io: 'input' | 'output') => (options: Parameters<typeof standard.jsonSchema.input>[0]) => {
    const key = `${io}:${options.target}:${JSON.stringify(options.libraryOptions ?? null)}`;
    let json = converted.get(key);
    if (!json) { json = frozen(standard.jsonSchema[io](options)); converted.set(key, json); }
    return json;
  };
  return { '~standard': { ...standard, jsonSchema: { input: once('input'), output: once('output') } } };
}
