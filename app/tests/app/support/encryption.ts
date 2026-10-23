import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { ENCRYPTED_WORKSPACES_PATH, type CreateEncryptedWorkspaceResult, type Workspace } from '@flux/contracts';
import { expectStatus, type Person } from './people.js';
import type { Browser, ClientResponse } from './http.js';

// Fixtures of encrypted workspaces (F-030, #655). Until S3 a sealed workspace is created only through the
// fixture-only route (FLUX_FIXTURE_TOKEN set on the API), with the creator's unlock password.

const WORDS = ['quartz', 'lantern', 'hollow', 'meadow', 'ripple', 'kestrel', 'saffron', 'glacier', 'violin', 'tundra', 'orchid', 'pebble',
  'cobalt', 'harbor', 'nimbus', 'thistle', 'walrus', 'ember', 'falcon', 'mosaic', 'juniper', 'canyon', 'velvet', 'basil', 'comet', 'ivory'];

/** A six-word passphrase, as the creation form generates (S3 uses the EFF large list). */
export function passphrase(): string {
  return Array.from({ length: 6 }, () => WORDS[randomInt(WORDS.length)]).join(' ') + ` ${randomInt(1000, 9999)}`;
}

export async function createSealed(owner: Person, name: string, password: string, creationId = randomUUID()) {
  const body = expectStatus(await owner.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name, creationId, password } }), 201) as CreateEncryptedWorkspaceResult;
  assert.ok(body.recoveryCode);
  return { workspace: body.workspace, recoveryCode: body.recoveryCode, creationId };
}

export const unlock = (browser: Browser, workspaceId: string, secret: { password: string } | { recoveryCode: string }) =>
  browser.request('POST', `/api/v1/workspaces/${workspaceId}/unlock`, { body: secret });
export const lock = (browser: Browser, workspaceId: string) => browser.request('POST', `/api/v1/workspaces/${workspaceId}/lock`);
export const readWorkspace = async (browser: Browser, workspaceId: string) =>
  expectStatus(await browser.request('GET', `/api/v1/workspaces/${workspaceId}`), 200) as Workspace;
/** A content route of the workspace (its project list): 423 while locked. */
export const contentCall = (browser: Browser, workspaceId: string) => browser.request('GET', `/api/v1/workspaces/${workspaceId}/projects`);
export const codeOf = (response: ClientResponse) => (response.json as { code?: string } | null)?.code;
