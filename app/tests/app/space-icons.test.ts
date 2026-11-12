import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import { PICTURE_LIMITS, picturePath, spaceIconPath, type Page, type Project, type SpaceIcon } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { createSealed, passphrase } from './support/encryption.js';
import { db, pool } from './support/db.js';
// The test pictures are made with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../apps/server/node_modules/sharp/dist/index.mjs';

// Space icons (F-040, #1227): the people who can rename a space set an emoji or a picture, or go back to the letter; a member cannot;
// the change is `project.updated.v1`; a picture follows F-039's pipeline with a 2 MiB limit and is served to the space's people only;
// an encrypted space keeps its letter.

const square = (colour: string, side = 40) => sharp({ create: { width: side, height: side, channels: 3, background: colour } }).png().toBuffer();

async function putPicture(who: Person, projectId: string, bytes: Uint8Array, type = 'image/png') {
  const response = await fetch(new URL(spaceIconPath(projectId), who.browser.base), {
    method: 'PUT', headers: { 'content-type': type, cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json().catch(() => null) as (SpaceIcon & { code?: string }) | null };
}
const putEmoji = (who: Person, projectId: string, emoji: unknown) => who.browser.request('PUT', spaceIconPath(projectId), { body: { emoji } });
const rendition = (who: Person, id: string, size: 64 | 128 | 256 = 64) =>
  fetch(new URL(picturePath(id, size), who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
const iconOf = async (who: Person, projectId: string) => (expectStatus(await who.browser.request('GET', `/api/v1/projects/${projectId}`), 200) as Project).icon;
const updates = async (projectId: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM events WHERE kind = $1 AND object_id = $2', ['project.updated.v1', projectId])).rows[0].n as number;

async function scene() {
  const owner = await person('Icon owner');
  const admin = await person('Icon space admin');
  const member = await person('Icon member');
  const outsider = await person('Icon outsider');
  const ws = await workspace(owner, 'Icon company');
  for (const someone of [admin, member, outsider]) await addMember(owner, ws.id, someone, 'member');
  const space = await project(owner, ws.id, 'Garden', 'restricted');
  await grant(owner, space.id, admin, 'manager');
  await grant(owner, space.id, member, 'contributor');
  return { owner, admin, member, outsider, ws, space };
}

test('the people who can rename a space set an emoji; a member cannot; every reader sees it; the change is project.updated', async () => {
  const f = await scene();
  assert.equal(f.space.icon, null, 'every space starts with its letter');
  assert.equal(await iconOf(f.member, f.space.id), null);
  const refused = await putEmoji(f.member, f.space.id, '🌱');
  assert.equal(refused.status, 403);
  assert.equal((await putPicture(f.member, f.space.id, await square('#0a0'))).status, 403);
  assert.equal((await f.member.browser.request('DELETE', spaceIconPath(f.space.id))).status, 403);
  assert.equal((await putEmoji(f.outsider, f.space.id, '🌱')).status, 404);
  assert.equal(await updates(f.space.id), 0);

  assert.deepEqual(expectStatus(await putEmoji(f.admin, f.space.id, '🌱'), 200), { emoji: '🌱' });
  assert.deepEqual(await iconOf(f.member, f.space.id), { emoji: '🌱' });
  const listed = expectStatus(await f.member.browser.request('GET', `/api/v1/workspaces/${f.ws.id}/projects`), 200) as Page<Project>;
  assert.deepEqual(listed.items.find((item) => item.id === f.space.id)?.icon, { emoji: '🌱' });
  assert.equal(await updates(f.space.id), 1);
  // The company's owner may too (they may rename it), and a joined emoji is one emoji.
  assert.deepEqual(expectStatus(await putEmoji(f.owner, f.space.id, '👩‍💻'), 200), { emoji: '👩‍💻' });
  for (const bad of ['', 'ab', '🌱🌱', 'A', 42, null, '<svg/>']) {
    const response = await putEmoji(f.owner, f.space.id, bad);
    assert.deepEqual([response.status, (response.json as { code?: string }).code], [400, 'INVALID_SPACE_EMOJI'], JSON.stringify(bad));
  }
  assert.deepEqual(await iconOf(f.member, f.space.id), { emoji: '👩‍💻' });

  assert.equal((await f.admin.browser.request('DELETE', spaceIconPath(f.space.id))).status, 204);
  assert.equal(await iconOf(f.member, f.space.id), null);
  assert.equal(await updates(f.space.id), 3);
});

test('a picture icon: types by their bytes, at most 2 MiB, served to the space only, replaced and removed cleanly', async () => {
  const f = await scene();
  const set = await putPicture(f.admin, f.space.id, await sharp({ create: { width: 90, height: 30, channels: 3, background: '#e80' } }).jpeg().toBuffer(), 'image/jpeg');
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const picture = set.body!.picture!;
  assert.deepEqual(await iconOf(f.member, f.space.id), { picture });
  for (const size of [64, 128, 256] as const) {
    const response = await rendition(f.member, picture, size);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const meta = await sharp(new Uint8Array(await response.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['webp', size, size, undefined]);
  }
  // Someone in the company but not in the space cannot see it, nor can someone signed out.
  assert.equal((await rendition(f.outsider, picture)).status, 404);
  assert.equal((await fetch(new URL(picturePath(picture, 64), f.member.browser.base))).status, 401);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  assert.deepEqual([(await putPicture(f.admin, f.space.id, svg)).status, (await putPicture(f.admin, f.space.id, svg)).body?.code], [400, 'UNSUPPORTED_PICTURE']);
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
  assert.equal((await putPicture(f.admin, f.space.id, gif)).body?.code, 'UNSUPPORTED_PICTURE');
  const big = Buffer.concat([await square('#000'), Buffer.alloc(PICTURE_LIMITS.spaceIconBytes)]);
  assert.equal((await putPicture(f.admin, f.space.id, big)).status, 413);
  assert.deepEqual(await iconOf(f.member, f.space.id), { picture }, 'a refused upload changes nothing');

  const [row] = await db.select().from(schema.spaceIcons).where(inArray(schema.spaceIcons.picture, [picture]));
  const objects = [row!.object64!, row!.object128!, row!.object256!];
  assert.deepEqual(expectStatus(await putEmoji(f.admin, f.space.id, '🌊'), 200), { emoji: '🌊' });
  assert.equal((await rendition(f.member, picture)).status, 404, 'a replaced picture is not served');
  assert.equal((await db.select().from(schema.fileGarbage).where(inArray(schema.fileGarbage.id, objects))).length, 3);

  const again = await putPicture(f.admin, f.space.id, await square('#06c'));
  assert.equal(again.status, 200);
  // Leaving the space ends the access to its picture.
  await pool.query('DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2', [f.space.id, f.member.id]);
  assert.equal((await rendition(f.member, again.body!.picture!)).status, 404);
  assert.equal((await rendition(f.admin, again.body!.picture!)).status, 200);
  assert.equal((await f.admin.browser.request('DELETE', spaceIconPath(f.space.id))).status, 204);
  assert.equal((await rendition(f.admin, again.body!.picture!)).status, 404);
});

test('deleting a space frees its picture; an encrypted space keeps its letter', async () => {
  const f = await scene();
  const set = await putPicture(f.admin, f.space.id, await square('#0a0'));
  const [row] = await db.select().from(schema.spaceIcons).where(inArray(schema.spaceIcons.picture, [set.body!.picture!]));
  assert.equal((await f.owner.browser.request('DELETE', `/api/v1/projects/${f.space.id}`)).status, 204);
  assert.equal((await db.select().from(schema.fileGarbage).where(inArray(schema.fileGarbage.id, [row!.object64!, row!.object128!, row!.object256!]))).length, 3);

  const sealed = await createSealed(f.owner, 'Icon vault', passphrase());
  const vault = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${sealed.workspace.id}/projects`, { body: { name: 'Vault room', visibility: 'workspace' } }), 201) as Project;
  const refused = await putEmoji(f.owner, vault.id, '🔒');
  assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [409, 'WORKSPACE_ENCRYPTED_UNSUPPORTED']);
  assert.equal((await putPicture(f.owner, vault.id, await square('#000'))).status, 409);
  assert.equal(await iconOf(f.owner, vault.id), null);
});
