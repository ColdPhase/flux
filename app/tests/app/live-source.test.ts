import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError } from '@flux/core';
import type { Conversation, Material, WorkItem } from '@flux/contracts';
import { requireLivePresentationSource } from '../../apps/server/src/live/access.js';
import { db } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

function missing(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('live presentation accepts only current, project-readable source versions inside the write transaction', async () => {
  const owner = await person('live-source-owner');
  const viewer = await person('live-source-viewer');
  const ws = await workspace(owner, 'Live sources');
  await addMember(owner, ws.id, viewer, 'member');
  const place = await project(owner, ws.id, 'Presented project', 'restricted');
  const elsewhere = await project(owner, ws.id, 'Foreign project', 'restricted');
  await grant(owner, place.id, viewer, 'viewer');

  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Project message', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/materials`, {
    body: { clientMutationId: randomUUID(), title: 'Project plan', body: 'Visible plan' },
  }), 201) as Material;
  const foreign = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/materials`, {
    body: { clientMutationId: randomUUID(), title: 'Other plan', body: 'Private elsewhere' },
  }), 201) as Material;
  const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
    body: { title: 'Review the plan' },
  }), 201) as WorkItem;

  const principal = { kind: 'human' as const, id: viewer.id };
  const messageRef = { type: 'message' as const, id: conversation.messages[0]!.id, version: 1 };
  const materialRef = { type: 'material' as const, id: material.materialId, version: 1 };
  const workRef = { type: 'work' as const, id: work.id, version: work.version };

  // The same check runs against the transaction that commits the identifier-only trace.
  await db.transaction(async (tx) => {
    await requireLivePresentationSource(principal, place.id, messageRef, tx, true);
    await requireLivePresentationSource(principal, place.id, materialRef, tx, true);
    await requireLivePresentationSource(principal, place.id, workRef, tx, true);
  });

  await assert.rejects(requireLivePresentationSource(principal, place.id,
    { type: 'material', id: foreign.materialId, version: 1 }, db), missing('LIVE_SOURCE_NOT_FOUND'));
  await assert.rejects(requireLivePresentationSource(principal, place.id,
    { ...materialRef, version: 2 }, db), missing('LIVE_SOURCE_NOT_FOUND'));
  await assert.rejects(requireLivePresentationSource(principal, place.id,
    { ...messageRef, version: 2 }, db), missing('LIVE_SOURCE_NOT_FOUND'));

  const changed = expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${work.id}`, {
    headers: { 'if-match': `"${work.version}"` }, body: { title: 'Review revised plan' },
  }), 200) as WorkItem;
  assert.equal(changed.version, work.version + 1);
  await assert.rejects(db.transaction((tx) => requireLivePresentationSource(principal, place.id, workRef, tx, true)),
    missing('LIVE_SOURCE_NOT_FOUND'));
  await db.transaction((tx) => requireLivePresentationSource(principal, place.id,
    { ...workRef, version: changed.version }, tx, true));

  await grant(owner, place.id, viewer, 'denied');
  await assert.rejects(db.transaction((tx) => requireLivePresentationSource(principal, place.id, materialRef, tx, true)),
    missing('PROJECT_NOT_FOUND'));
});
