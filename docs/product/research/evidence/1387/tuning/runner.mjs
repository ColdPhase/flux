// Runs the repository's own searchRows(db).ranked (the built @flux/db of the image) on the tuning database, for the 60 bench questions in
// the three forms, with the live test's plan (searchRows-vectors-live.test.ts planOf). Prints one JSON line per question.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema, searchRows, AUDIENCE_KEYS, sql } from '@flux/db';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = drizzle(pool, { schema });
AUDIENCE_KEYS.members = () => sql`SELECT DISTINCT audience_key FROM search_documents`;
const audiences = [{ type: 'members', workspaceId: '00000000-0000-0000-0000-000000000000', condition: null }];
const seed = JSON.parse(readFileSync('/work/seed.json', 'utf8'));
const plain = (words) => words.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const people = process.env.PEOPLE === '1';
const WORD = /[\p{L}\p{N}]+/gu;
function planOf(q, words, limit) {
  const base = { text: words, prefix: null, fuzzy: false, number: null, words: plain(words), kinds: null, place: null, author: null, after: null, limit, reader: 'bench' };
  if (people) {
    const ws = (words.match(WORD) ?? []).map((w) => w.toLowerCase());
    const last = /[\p{L}\p{N}]$/u.test(words) && ws.length ? ws.slice(-12) : null;
    Object.assign(base, { fuzzy: true, words: ws.join(' '), prefix: last ? [...last.slice(0, -1), `${last.at(-1)}:*`].join(' & ') : null });
  }
  return { ...base, since: q.after ? new Date(q.after) : null, until: q.before ? new Date(q.before) : null };
}
const forms = (process.env.FORMS ?? 'question keywords bilingual').split(' ');
const times = [];
for (const form of forms) for (const q of seed.questions) {
  const words = form === 'bilingual' ? `${q.keywords} ${q.keywords_other}` : q[form];
  const t = performance.now();
  const hits = await searchRows(db).ranked(audiences, planOf(q, words, 100));
  times.push(performance.now() - t);
  console.log(JSON.stringify({ form, q: q.id, lex: hits.map((h) => h.objectId), scores: hits.slice(0, 12).map((h) => h.position.score) }));
}
times.sort((a, b) => a - b);
console.error(`ranked: ${times.length} statements, median ${times[times.length >> 1].toFixed(1)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)} ms`);
await pool.end();
