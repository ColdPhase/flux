import type { FileStorage } from '@flux/core';

// The files volume an agent's own staged uploads are checked against when a local client's post carries them (#1437): set once at start
// (app.ts, with the agent file services); absent, a post that names a file is refused as before ("Files are unavailable").
let storage: FileStorage | null = null;
export function setAgentFileStorage(next: FileStorage | null) { storage = next; }
export const agentFileStorage = (): FileStorage | null => storage;
