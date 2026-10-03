import process from 'node:process';
// Deliberately exit before readiness, within this worker only.
process.exit(0);
