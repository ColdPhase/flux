import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { READS_LIMIT, READS_PATH, type FoldedReadsResponse, type Project } from '@flux/contracts';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #862: several reads in one request. Each is answered by its own route, as the same session: access, refusals and bodies are the
// same as asking for each; only the reads the web client folds, at most READS_LIMIT, and nothing that leaves the API.

const folded = (who: { browser: Browser }, paths: string[]) => who.browser.request('GET', `${READS_PATH}?${paths.map((path) => `path=${encodeURIComponent(path)}`).join('&')}`);

describe('folded reads', () => {
  let ada: Person; let ben: Person;
  let open: Project; let closed: Project;

  before(async () => {
    [ada, ben] = await Promise.all([person('folded-ada'), person('folded-ben')]);
    const ws = await workspace(ada, 'Folded reads');
    await addMember(ada, ws.id, ben, 'member');
    open = await project(ada, ws.id, 'Open to Ben', 'restricted');
    await grant(ada, open.id, ben, 'contributor');
    closed = await project(ada, ws.id, 'Not for Ben', 'restricted');
  });

  test('each read is answered as its own request would be: the same status and the same body, for this session', async () => {
    const paths = [`/api/v1/projects/${open.id}`, `/api/v1/projects/${open.id}/people`, `/api/v1/projects/${closed.id}`, `/api/v1/projects/${closed.id}/conversation-roots`];
    const response = expectStatus(await folded(ben, paths), 200) as FoldedReadsResponse;
    assert.equal(response.answers.length, paths.length);
    for (const [index, path] of paths.entries()) {
      const alone = await ben.browser.request('GET', path);
      const answer = response.answers[index]!;
      assert.equal(answer.status, alone.status, path);
      assert.deepEqual(JSON.parse(answer.body), alone.json, path);
    }
    assert.deepEqual(response.answers.map((answer) => answer.status), [200, 200, 404, 404], 'Ben opens his space and not the other');
    // Without a session every read is refused as it would be alone.
    const stranger = expectStatus(await folded({ browser: new Browser() }, [`/api/v1/projects/${open.id}`, '/api/v1/needs-you']), 200) as FoldedReadsResponse;
    assert.deepEqual(stranger.answers.map((answer) => answer.status), [401, 401]);
  });

  test('only the reads that are folded, at most the limit: nothing else, nothing that leaves the API, never by another method', async () => {
    const one = `/api/v1/projects/${open.id}`;
    for (const paths of [
      [], Array.from({ length: READS_LIMIT + 1 }, () => one), ['/api/v1/search?q=lamp'], ['/api/v1/stream'], [`${READS_PATH}?path=${encodeURIComponent(one)}`],
      [`/api/v1/projects/${open.id}/../../workspaces`], ['//evil.example/api/v1/needs-you'], ['http://evil.example/api/v1/needs-you'], [`/api/v1/projects/${open.id}/people#x`],
      [`/api/v1/projects/${open.id}/people?x=<script>`], ['/api/v1/files/anything'], ['/api/auth/get-session'],
    ]) {
      const response = await folded(ben, paths);
      assert.equal(response.status, 400, `${paths.join(' ')}: ${response.text}`);
      assert.equal((response.json as { code?: string }).code, 'READS_INVALID');
    }
    assert.equal((await ben.browser.request('POST', `${READS_PATH}?path=${encodeURIComponent(one)}`)).status, 404, 'a read only: no other method');
    expectStatus(await folded(ben, Array.from({ length: READS_LIMIT }, () => one)), 200);
  });
});
