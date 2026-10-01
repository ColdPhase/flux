import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { checkManifests, checkSources, compare, layerOf, loadExceptions, reachableImports, scanRepository } from './support/architecture.js';

// Repository-wide Clean Architecture rules (issue #46). The layers and their allowed
// dependencies are defined in support/architecture.ts and explained in
// docs/development/architecture.md. Known debt is listed in architecture-allowlist.json;
// the test fails on a new violation and on an allowlist entry that has been fixed.
const root = resolve(import.meta.dirname, '../..');
const allowlist = join(root, 'tests/app/architecture-allowlist.json');
const packageRoots = ['packages/contracts', 'packages/sdk', 'packages/core', 'packages/db', 'apps/web', 'apps/server', 'apps/worker', 'examples/external-agent'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('architecture boundaries', () => {
  test('the repository has no dependency violation outside the recorded allowlist', () => {
    const { sources, violations } = scanRepository(root);
    assert.ok(sources.length >= 40, `the scan covers the application sources (found ${sources.length})`);
    for (const { path } of sources) assert.ok(layerOf(path), `${path} belongs to a documented layer`);
    const { unexpected, stale } = compare(violations, loadExceptions(allowlist));
    assert.deepEqual(unexpected, [], 'new violations: follow docs/development/architecture.md instead of extending the allowlist');
    assert.deepEqual(stale, [], 'fixed violations: remove these entries from tests/app/architecture-allowlist.json');
  });

  test('every allowlist entry names its tracking issue and a reason', () => {
    for (const entry of loadExceptions(allowlist)) {
      assert.match(entry.issue, /^https:\/\/github\.com\/ColdPhase\/flux\/issues\/\d+$/, `${entry.file} -> ${entry.import}`);
      assert.ok(entry.reason.length > 20, `${entry.file} -> ${entry.import} explains the debt`);
    }
  });

  test('the push use cases in core stay free of adapters, including through helpers', () => {
    const entries = files(join(root, 'packages/core/src/push'));
    assert.ok(entries.length >= 5, 'the push use cases and ports exist');
    assert.deepEqual(reachableImports(root, entries, ['@flux/db', 'drizzle-orm', 'pg', 'pg-boss', 'fastify', 'web-push']), []);
  });

  test('the sketch use cases in core stay free of adapters, including through helpers (#69)', () => {
    const entries = files(join(root, 'packages/core/src/sketches'));
    assert.ok(entries.length >= 3, 'the sketch use cases and ports exist');
    assert.deepEqual(reachableImports(root, entries, ['@flux/db', 'drizzle-orm', 'pg', 'pg-boss', 'fastify', 'web-push']), []);
  });

  test('the direct-message use cases in core stay free of adapters, including through helpers (#107)', () => {
    const entries = files(join(root, 'packages/core/src/direct-messages'));
    assert.ok(entries.length >= 3, 'the direct-message use cases and ports exist');
    assert.deepEqual(reachableImports(root, entries, ['@flux/db', 'drizzle-orm', 'pg', 'pg-boss', 'fastify', 'web-push']), []);
  });

  test('the bounded work read use cases stay free of persistence and transport adapters (#155)', () => {
    const entries = files(join(root, 'packages/core/src/work-read'));
    assert.ok(entries.length >= 5, 'the bounded read use cases, cursor and ports exist');
    assert.deepEqual(reachableImports(root, entries, ['@flux/db', 'drizzle-orm', 'pg', 'pg-boss', 'fastify']), []);
  });

  test('the rules reject each kind of boundary violation (self-test)', () => {
    const source = (path: string, text: string) => ({ path, text });
    const found = checkSources([
      source('packages/core/src/x/use-case.ts', "import { eq } from 'drizzle-orm';\nimport type { Database } from '@flux/db';"),
      source('packages/core/src/x/ok.ts', "import { randomUUID } from 'node:crypto';\nimport type { Actor } from '@flux/contracts';\nimport { a } from './helper.js';"),
      source('packages/contracts/src/x.ts', "import { z } from 'some-schema-lib';"),
      source('packages/sdk/src/x.ts', "export { authorize } from '@flux/core';"),
      source('apps/web/src/x.tsx', "const db = await import('@flux/db');\nimport { useState } from 'react';"),
      source('apps/web/src/fs-bare.ts', "import fs from 'fs';"),
      source('apps/web/src/fs-prefixed.ts', "import { readFile } from 'node:fs';"),
      source('apps/web/src/fs-subpath.ts', "import { readFile } from 'fs/promises';"),
      source('packages/core/src/x/bare-builtin-ok.ts', "import { createHash } from 'crypto';"),
      source('apps/worker/src/x.ts', "import Fastify from 'fastify';"),
      source('apps/server/src/x.ts', "import { schema } from '../../../packages/db/src/schema.js';"),
      source('apps/server/src/y.ts', "import { schema } from '@flux/db/src/schema.js';"),
      source('examples/external-agent/x.ts', "import { authorize } from '@flux/core';"),
    ], packageRoots).map((violation) => `${violation.file} -> ${violation.import}`);
    assert.deepEqual(found, [
      'packages/core/src/x/use-case.ts -> drizzle-orm',
      'packages/core/src/x/use-case.ts -> @flux/db',
      'packages/contracts/src/x.ts -> some-schema-lib',
      'packages/sdk/src/x.ts -> @flux/core',
      'apps/web/src/x.tsx -> @flux/db',
      'apps/web/src/fs-bare.ts -> fs',
      'apps/web/src/fs-prefixed.ts -> node:fs',
      'apps/web/src/fs-subpath.ts -> fs/promises',
      'apps/worker/src/x.ts -> fastify',
      'apps/server/src/x.ts -> ../../../packages/db/src/schema.js',
      'apps/server/src/y.ts -> @flux/db/src/schema.js',
      'examples/external-agent/x.ts -> @flux/core',
    ]);
    const manifest = checkManifests([{ path: 'packages/core/package.json', dependencies: { '@flux/contracts': 'workspace:*', 'pg-boss': '1.0.0' } }]);
    assert.deepEqual(manifest.map((violation) => violation.import), ['pg-boss']);
  });

  test('the allowlist comparison reports new and fixed violations', () => {
    const exception = { file: 'packages/core/src/a.ts', import: '@flux/db', issue: 'https://github.com/ColdPhase/flux/issues/46', reason: 'recorded debt for the self-test' };
    const result = compare([{ file: 'packages/core/src/b.ts', import: 'pg-boss', rule: 'core may only depend on ...' }], [exception]);
    assert.deepEqual(result.unexpected, ['packages/core/src/b.ts -> pg-boss: core may only depend on ...']);
    assert.deepEqual(result.stale, ['packages/core/src/a.ts -> @flux/db']);
  });
});
