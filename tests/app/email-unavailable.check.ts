import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { InboxResponse, NotificationPreferences } from '@flux/contracts';
import { mailCount, register, uniqueEmail } from './support/http.js';
import { addMember, expectStatus, password, workspace } from './support/people.js';
import { waitFor } from './support/push.js';

// Run by scripts/check_application.sh after the API and worker restart without FLUX_SMTP_URL
// (issues #116, #113): email delivery is visibly unavailable and nothing is dropped silently —
// notifications still reach the inbox, and no email is queued.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(async () => { await pool.end(); });

async function someone(name: string) {
  const email = uniqueEmail(name.toLowerCase());
  const { browser } = await register(email, password, name);
  const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
  return { id: me.user.id, email, browser };
}

test('without SMTP, settings say email delivery is unavailable and the inbox still fills', async () => {
  const sender = await someone('Nell');
  const reader = await someone('Ozzy');
  const space = (await workspace(sender, 'No mail co-op')).id;
  await addMember(sender, space, reader, 'member');

  const view = expectStatus(await reader.browser.request('GET', '/api/v1/notification-preferences'), 200) as NotificationPreferences;
  assert.equal(view.email.available, false);
  const add = await reader.browser.request('POST', '/api/v1/notification-address', { body: { email: uniqueEmail('extra') } });
  assert.equal(add.status, 503);
  assert.equal((add.json as { code: string }).code, 'EMAIL_UNAVAILABLE');

  const dm = expectStatus(await sender.browser.request('POST', `/api/v1/workspaces/${space}/dms`, { body: { participantIds: [reader.id] } }), 201) as { id: string };
  const message = expectStatus(await sender.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'The meeting moved to Thursday', clientMessageId: randomUUID() } }), 201) as { id: string };
  await waitFor(async () => {
    const inbox = expectStatus(await reader.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse;
    return inbox.items.some((item) => item.url?.endsWith(message.id));
  }, 'the DM in the inbox');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await pool.query('SELECT 1 FROM notification_emails WHERE user_id = $1', [reader.id])).rowCount, 0, 'no email is queued');
  assert.equal(await mailCount(reader.email), 0);
});
