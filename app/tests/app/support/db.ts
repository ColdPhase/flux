import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { createDatabase, schema } from '@flux/db';
import type { Principal } from '@flux/core';

// The Compose PostgreSQL for tests that read or write rows directly (#83). Each test file runs in
// its own process, so this is one pool per file, closed after the file's tests.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
export const connectionString: string = url;
export const database = createDatabase(connectionString);
export const { db, pool } = database;
after(() => pool.end());

/** A person inserted directly as a user row, for tests that drive core without signing up over HTTP. */
export async function insertedHuman(label: string): Promise<Principal> {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id}@example.test` });
  return { id, kind: 'human' };
}
