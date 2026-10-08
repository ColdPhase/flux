import { fakeCli } from './fake-cli.js';

// TEST ONLY: the fake `claude` (see fake-cli.ts).
process.exitCode = fakeCli('claude_code', process.argv.slice(2));
