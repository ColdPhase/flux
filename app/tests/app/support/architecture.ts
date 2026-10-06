import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Repository-wide dependency rules (issue #46, docs/development/architecture.md).
// Each source file belongs to the first layer whose path prefix matches it. A layer either
// lists the only packages it may import (`allow`) or the packages it must not import (`deny`).
// The same rule applies to the `dependencies` of the layer's package.json.

export interface Layer {
  name: string;
  /** Repository-relative path prefixes, with forward slashes. */
  paths: string[];
  /** When set, the only external packages the layer may import. `node:*` allows built-ins. */
  allow?: string[];
  /** External packages the layer must never import. */
  deny?: string[];
}

const UI = ['react', 'react-dom'];
const PERSISTENCE = ['@flux/db', 'drizzle-orm', 'pg', 'pg-boss'];
const HTTP = ['fastify', '@fastify/*'];
const APPS = ['@flux/server', '@flux/worker', '@flux/web', '@flux/runtime'];

export const LAYERS: Layer[] = [
  // Public wire types, Apache-2.0: portable, no runtime dependencies at all.
  { name: 'contracts', paths: ['packages/contracts/'], allow: [] },
  // Public API client, Apache-2.0: only the wire types.
  { name: 'sdk', paths: ['packages/sdk/'], allow: ['@flux/contracts'] },
  // Domain rules, use cases and ports: no persistence, queue, HTTP, push or UI library.
  { name: 'core', paths: ['packages/core/'], allow: ['@flux/contracts', 'node:*'] },
  // Persistence adapters: implement core ports with Drizzle/PostgreSQL. No HTTP, queue or UI.
  { name: 'db', paths: ['packages/db/'], allow: ['@flux/contracts', '@flux/core', 'drizzle-orm', 'pg', 'node:*'] },
  // Optional model/provider adapter: no direct database, queue, HTTP server or UI.
  { name: 'agent-runtime', paths: ['packages/agent-runtime/'], deny: [...PERSISTENCE, ...HTTP, ...APPS, ...UI] },
  // The `runtime` transport's internal protocol and manager client (F-022 AIM-3): Node built-ins only,
  // so the slot image carries nothing else.
  { name: 'runtime-protocol', paths: ['packages/runtime-protocol/'], allow: ['node:*'] },
  // Supervisor, manager, egress and installer of the runtime slots: no database, queue, HTTP framework,
  // domain package or app; only the protocol and Node built-ins.
  { name: 'runtime', paths: ['apps/runtime/'], allow: ['@flux/runtime-protocol', 'node:*'] },
  // Browser application: talks to the server only through HTTP/WebSocket contracts. UI
  // libraries are its own choice; server-side packages and Node built-ins are not.
  { name: 'web', paths: ['apps/web/src/'], deny: ['@flux/core', '@flux/db', '@flux/agent-runtime', '@flux/runtime-protocol', ...APPS, ...PERSISTENCE, ...HTTP, 'web-push', 'nodemailer', 'node:*'] },
  // Web build tooling (Vite config and plugins, icon generation): never application code.
  { name: 'web-build', paths: ['apps/web/'], deny: ['@flux/core', '@flux/db', '@flux/server', '@flux/worker', 'drizzle-orm', 'pg', 'pg-boss', ...HTTP] },
  // Composition roots and adapters. They may wire everything except each other and the UI.
  { name: 'server', paths: ['apps/server/'], deny: ['@flux/worker', '@flux/web', ...UI] },
  { name: 'worker', paths: ['apps/worker/'], deny: ['@flux/server', '@flux/web', ...HTTP, ...UI] },
  // Apache-2.0 example of an external agent: only the public SDK and wire types.
  { name: 'examples', paths: ['examples/'], allow: ['@flux/sdk', '@flux/contracts', 'node:*'] },
  // Deployment and migration entry points.
  { name: 'tooling', paths: ['tooling/'], deny: [...APPS, ...UI] },
];

const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const SKIP = new Set(['node_modules', 'dist', 'migrations']);
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;

export interface Source {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
}

export interface Violation {
  file: string;
  import: string;
  rule: string;
}

const posix = (path: string) => path.split(sep).join('/');

export function layerOf(path: string) {
  return LAYERS.find((layer) => layer.paths.some((prefix) => path.startsWith(prefix)));
}

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

/**
 * The npm package a bare specifier names: `@scope/name` or `name`. Node built-ins map to
 * `node:*` whether written `node:fs`, `fs` or `fs/promises`, so rules cannot be bypassed.
 */
export function packageOf(specifier: string) {
  if (specifier.startsWith('node:')) return 'node:*';
  if (BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]!)) return 'node:*';
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function matches(pattern: string, pkg: string) {
  return pattern.endsWith('/*') ? pkg.startsWith(pattern.slice(0, -1)) : pattern === pkg;
}

/** Why `pkg` is not allowed in `layer`, or undefined when it is. */
function breaks(layer: Layer, pkg: string) {
  if (layer.deny?.some((pattern) => matches(pattern, pkg))) return `${layer.name} must not depend on ${pkg}`;
  if (layer.allow && !layer.allow.some((pattern) => matches(pattern, pkg))) return `${layer.name} may only depend on ${layer.allow.join(', ') || 'nothing external'}`;
  return undefined;
}

export function specifiers(text: string) {
  return [...text.matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]!);
}

/**
 * Violations in the given files. `packageRoots` are the repository-relative directories of the
 * workspace packages (for example `packages/core`); a relative import must stay inside its own.
 */
export function checkSources(sources: Source[], packageRoots: string[]): Violation[] {
  const rootOf = (path: string) => packageRoots.filter((root) => path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0];
  const violations: Violation[] = [];
  for (const { path, text } of sources) {
    const layer = layerOf(path);
    for (const specifier of specifiers(text)) {
      if (specifier.startsWith('.')) {
        const target = posix(join(dirname(path), specifier));
        const own = rootOf(path);
        if (own && !target.startsWith(`${own}/`)) violations.push({ file: path, import: specifier, rule: `relative import leaves ${own}; import the workspace package instead` });
        continue;
      }
      if (/^@flux\/[^/]+\/(src|dist)(\/|$)/.test(specifier)) {
        violations.push({ file: path, import: specifier, rule: 'deep import into a workspace package; use its public entry point' });
        continue;
      }
      const reason = layer && breaks(layer, packageOf(specifier));
      if (reason) violations.push({ file: path, import: specifier, rule: reason });
    }
  }
  return violations;
}

/** Violations in the runtime `dependencies` of each workspace package.json. */
export function checkManifests(manifests: { path: string; dependencies: Record<string, string> }[]): Violation[] {
  return manifests.flatMap(({ path, dependencies }) => {
    const layer = layerOf(path.replace(/package\.json$/, 'src/')) ?? layerOf(path);
    if (!layer) return [];
    return Object.keys(dependencies).flatMap((pkg) => {
      const reason = breaks(layer, pkg);
      return reason ? [{ file: path, import: pkg, rule: reason }] : [];
    });
  });
}

function walk(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name) || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(root, path);
    return SOURCE.test(name) && !name.endsWith('.d.ts') ? [posix(relative(root, path))] : [];
  });
}

/** Scans the repository's layered source trees and workspace manifests. */
export function scanRepository(root: string) {
  const trees = ['apps', 'packages', 'examples', 'tooling'];
  const packageRoots = ['apps', 'packages', 'examples'].flatMap((group) => {
    const dir = join(root, group);
    return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'package.json'))).map((name) => `${group}/${name}`) : [];
  });
  const sources = trees.flatMap((tree) => walk(root, join(root, tree))).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  const manifests = packageRoots.map((dir) => {
    const path = `${dir}/package.json`;
    const json = JSON.parse(readFileSync(join(root, path), 'utf8')) as { dependencies?: Record<string, string> };
    return { path, dependencies: json.dependencies ?? {} };
  });
  return { sources, packageRoots, violations: [...checkSources(sources, packageRoots), ...checkManifests(manifests)] };
}

export interface Exception {
  file: string;
  import: string;
  issue: string;
  reason: string;
}

export function loadExceptions(path: string): Exception[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { exceptions: Exception[] }).exceptions;
}

const key = (entry: { file: string; import: string }) => `${entry.file} -> ${entry.import}`;

/** New violations (not in the allowlist) and stale exceptions (allowlisted but already fixed). */
export function compare(violations: Violation[], exceptions: Exception[]) {
  const allowed = new Set(exceptions.map(key));
  const found = new Set(violations.map(key));
  return {
    unexpected: violations.filter((violation) => !allowed.has(key(violation))).map((violation) => `${key(violation)}: ${violation.rule}`),
    stale: exceptions.filter((exception) => !found.has(key(exception))).map(key),
  };
}

/** Relative-import closure from the entry files, reporting any import of the given packages. */
export function reachableImports(root: string, entries: string[], forbidden: string[]) {
  const violations: string[] = [];
  const seen = new Set<string>();
  const resolveRelative = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate;
    throw new Error(`Cannot resolve ${specifier} from ${relative(root, from)}`);
  };
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) visit(resolveRelative(file, specifier), [...chain, posix(relative(root, file))]);
      else if (forbidden.some((pattern) => matches(pattern, packageOf(specifier)))) violations.push(`${posix(relative(root, file))}: ${specifier}${chain.length ? ` (via ${chain.join(' -> ')})` : ''}`);
    }
  };
  for (const entry of entries) visit(entry, []);
  return violations;
}
