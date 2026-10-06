import { fakeCli } from './fake-cli.js';

// TEST ONLY: the fake `codex` (see fake-cli.ts).
process.exitCode = fakeCli('codex', process.argv.slice(2));
