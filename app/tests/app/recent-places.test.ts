import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeOfPath } from '../../apps/web/src/search/recent.js';

/**
 * ⌘K's "Recent" (#521, F-026 E02) keeps places by identity, not by address: one entry per project view, direct message,
 * the Inbox and Home, holding the address last seen there. Pages that are not places are never kept.
 */
const P = '11111111-1111-4111-8111-111111111111';
const key = (path: string) => placeOfPath(path)?.key ?? null;

test('a project view is one place whichever page of it was open', () => {
  assert.equal(key(`/projects/${P}`), `project:${P}:conversation`);
  assert.equal(key(`/projects/${P}/conversations/abc`), `project:${P}:conversation`);
  assert.deepEqual(placeOfPath(`/projects/${P}/conversations/abc`), { key: `project:${P}:conversation`, path: `/projects/${P}/conversations/abc` });
  assert.equal(key(`/projects/${P}/tasks`), `project:${P}:tasks`);
  assert.equal(key(`/projects/${P}/map`), `project:${P}:map`);
  assert.equal(key(`/projects/${P}/map/sketch-1`), `project:${P}:map`);
  assert.equal(key(`/projects/${P}/agents`), `project:${P}:agents`);
});

test('a doc version folds into its doc, and the Wiki is one place', () => {
  assert.deepEqual(placeOfPath(`/projects/${P}/docs/d1/versions/3`), { key: `project:${P}:docs`, path: `/projects/${P}/docs/d1` });
  assert.deepEqual(placeOfPath(`/projects/${P}/docs/d1`), { key: `project:${P}:docs`, path: `/projects/${P}/docs/d1` });
  assert.deepEqual(placeOfPath(`/projects/${P}/docs`), { key: `project:${P}:docs`, path: `/projects/${P}/docs` });
});

test('editors, history, live sessions, settings, setup and unknown addresses are not places', () => {
  for (const path of [`/projects/${P}/docs/new`, `/projects/${P}/docs/d1/edit`, `/projects/${P}/docs/d1/history`, `/projects/${P}/live/s1`,
    `/projects/${P}/github`, `/projects/${P}/nowhere`, '/projects/new', '/projects', '/dm/new', '/search', '/settings', '/settings/appearance',
    '/materials/m1', '/nowhere', '/sign-in']) {
    assert.equal(placeOfPath(path), null, path);
  }
});

test('a direct message, the Inbox and Home are one place each', () => {
  assert.deepEqual(placeOfPath('/dm/d1'), { key: 'dm:d1', path: '/dm/d1' });
  assert.deepEqual(placeOfPath('/dm/d1/sketches/s1'), { key: 'dm:d1', path: '/dm/d1' });
  assert.deepEqual(placeOfPath('/inbox/n1'), { key: 'inbox', path: '/inbox' });
  assert.deepEqual(placeOfPath('/'), { key: 'home', path: '/' });
  assert.equal(key('/tasks'), 'home:tasks');
  assert.equal(key('/docs'), 'home:docs');
  assert.equal(key('/map/s1'), 'sketchbook');
});
