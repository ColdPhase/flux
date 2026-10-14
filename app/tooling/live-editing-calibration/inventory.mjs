import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { CAPS } from './caps.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packages = new Map();
function inspect(path) {
  const metadata = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const key = `${metadata.name}@${metadata.version}`;
  const licenseFiles = readdirSync(path).filter((file) => /^(license|copying)(\.(md|txt))?$/i.test(file))
    .map((file) => ({ file, sha256: sha(readFileSync(join(path, file))) }));
  packages.set(key, { name: metadata.name, version: metadata.version, license: metadata.license ?? null, licenseFiles });
}
for (const entry of readdirSync('node_modules/.pnpm')) {
  const root = join('node_modules/.pnpm', entry, 'node_modules');
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith('@')) {
        for (const scoped of readdirSync(join(root, name))) inspect(join(root, name, scoped));
      } else if (statSync(join(root, name)).isDirectory()) inspect(join(root, name));
    }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
}
const dependencies = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
if (dependencies.some((pkg) => pkg.license !== 'MIT' || pkg.licenseFiles.length === 0)) {
  throw new Error('Unexpected dependency license or absent source license; record and review before codec execution');
}
if (dependencies.filter((pkg) => pkg.name === 'yjs').length !== 1) throw new Error('Multiple Yjs instances');
process.stdout.write(`${JSON.stringify({ recordedAt: new Date().toISOString(), versions: process.versions,
  lockSha256: sha(readFileSync('pnpm-lock.yaml')), caps: CAPS, dependencies }, null, 2)}\n`);
