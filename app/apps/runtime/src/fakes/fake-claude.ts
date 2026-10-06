import { fakeCli } from './fake-cli.js';

// TEST ONLY: the fake `claude` (see fake-cli.ts). It exits explicitly: a sign-in leaves the terminal's
// input open, and terminal output is written synchronously.
process.exit(await fakeCli('claude_code', process.argv.slice(2)));
