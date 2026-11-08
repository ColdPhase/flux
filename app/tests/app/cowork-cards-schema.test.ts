import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';

// #153 AC-2/AC-4, #400 AC-4: who cancelled a request. The project's review rule table is gone (#959, C-9).

test('the canceller column exists, and the review rule table is gone', async () => {
  assert.deepEqual((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'cowork_requests' AND column_name = 'cancelled_by'")).rows,
    [{ is_nullable: 'YES' }], 'every earlier request was cancelled by no one');
  assert.equal((await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'cowork_requests'::regclass AND confrelid = 'auth_users'::regclass`)).rows[0]?.confdeltype, 'n',
    'closing the account of the person who cancelled keeps the request');
  assert.equal((await pool.query("SELECT to_regclass('public.cowork_review_policies') AS table_name")).rows[0].table_name, null, 'the project review rule table is gone (0017, C-9)');
});
