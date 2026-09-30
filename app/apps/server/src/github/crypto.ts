import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function seal(key: Buffer, value: string, audience: string) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(audience));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function unseal(key: Buffer, value: string, audience: string) {
  const [version, nonce, tag, body, extra] = value.split('.');
  if (version !== 'v1' || !nonce || !tag || !body || extra) throw new Error('Invalid provider credential envelope');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  cipher.setAAD(Buffer.from(audience)); cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
}
