import { createHash } from 'node:crypto';
export function sanitized(line) {
  let item; try { item = JSON.parse(line); } catch { return null; }
  if (item.job !== 'push.send' || typeof item.id !== 'string' || typeof item.subscriptionId !== 'string') return null;
  const alias = id => createHash('sha256').update(id).digest('hex').slice(0, 12);
  const outcomes = ['sent', 'removed', 'skipped', 'deferred', 'rejected'];
  if (!outcomes.includes(item.outcome)) return null;
  return { job: alias(item.id), subscription: alias(item.subscriptionId), outcome: item.outcome,
    status: typeof item.status === 'number' ? item.status : null };
}
if (process.argv[1]?.endsWith('/sanitize-worker.mjs')) {
  let remainder = ''; let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length; if (total > 10_485_760) throw new Error('Worker log cap exceeded');
    remainder += chunk.toString();
    const lines = remainder.split('\n'); remainder = lines.pop();
    for (const line of lines) { const item = sanitized(line); if (item) console.log(JSON.stringify(item)); }
  }
  const item = sanitized(remainder); if (item) console.log(JSON.stringify(item));
}
