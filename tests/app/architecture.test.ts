import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';

// Clean Architecture boundary (issue #46): the notification/push use cases in core depend only
// on their ports, never on persistence or queue libraries. The check follows relative imports
// transitively, so a helper that pulls in Drizzle also fails it.
const root = resolve(import.meta.dirname, '../..');
const FORBIDDEN = [/^drizzle-orm(\/|$)/, /^@flux\/db(\/|$)/, /^pg-boss(\/|$)/, /^pg(\/|$)/, /^fastify(\/|$)/, /^web-push(\/|$)/];
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(file: string) {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

function resolveRelative(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate;
  throw new Error(`Cannot resolve ${specifier} from ${relative(root, from)}`);
}

/** Every forbidden import reachable from the entry files, as "file: specifier (via chain)". */
export function forbiddenImports(entries: string[]) {
  const violations: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith('.')) visit(resolveRelative(file, specifier), [...chain, relative(root, file)]);
      else if (FORBIDDEN.some((pattern) => pattern.test(specifier))) violations.push(`${relative(root, file)}: ${specifier}${chain.length ? ` (via ${chain.join(' -> ')})` : ''}`);
    }
  };
  for (const entry of entries) visit(entry, []);
  return violations;
}

describe('architecture boundaries', () => {
  test('packages/core/src/push/** does not import Drizzle, @flux/db, pg-boss or other adapters', () => {
    const entries = files(join(root, 'packages/core/src/push'));
    assert.ok(entries.length >= 5, 'the push use cases and ports exist');
    assert.deepEqual(forbiddenImports(entries), []);
  });

  test('the check detects a forbidden import (self-test against the SQL-backed access policy)', () => {
    const violations = forbiddenImports([join(root, 'packages/core/src/access/policy.ts')]);
    assert.ok(violations.some((line) => line.includes('drizzle-orm')), violations.join('\n'));
    assert.ok(violations.some((line) => line.includes('@flux/db')), violations.join('\n'));
  });
});
