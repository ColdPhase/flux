import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** A `Bearer` header that carries exactly `secret`, compared in constant time. */
export function authorized(header: string | undefined, secret: string): boolean {
  const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header ?? '');
  return Boolean(match) && secret.length > 0 && timingSafeEqual(digest(match![1]!), digest(secret));
}
