import { writeFileSync } from 'node:fs';
import { fluxCodexCatalog } from '../supervisor/templates.js';
import { FAKE_CODEX_CATALOG } from './fake-models.js';

// TEST ONLY (docker/Dockerfile `agent-runtime-test`): `node fake-catalog.js <out>` writes the fake pinned Codex's model catalog with Flux's review
// applied, at the place the real image keeps Flux's copy (`CODEX_MODEL_CATALOG`), so a run on the fake Codex cuts its own from it (#1332).
const target = process.argv[2];
if (!target) throw new Error('Usage: fake-catalog.js <out>');
writeFileSync(target, `${JSON.stringify(fluxCodexCatalog(FAKE_CODEX_CATALOG))}\n`, { mode: 0o644 });
