import { readFile, writeFile } from 'node:fs/promises';
import { fluxCodexCatalog } from '../supervisor/templates.js';

// Image build only (docker/Dockerfile `codex-catalog`, #1127): `node codex-catalog.js <pinned models.json> <out>` writes Flux's copy of
// the pinned Codex's model catalog, with the tool settings Flux reviewed (templates.ts CODEX_MODEL_REVIEW), for `model_catalog_json`.
const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: codex-catalog.js <pinned models.json> <out>');
const catalog = fluxCodexCatalog(JSON.parse(await readFile(source, 'utf8')) as unknown);
await writeFile(target, `${JSON.stringify(catalog)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ event: 'codex_catalog', models: catalog.models.map((model) => model.slug) }));
