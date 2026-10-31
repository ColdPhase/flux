import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Invite link tokens (F-035, #763 PE-2): the invite id and an HMAC of it under a key derived from the server's identity
// secret. Only the SHA-256 of a token is stored; a genuine token is recognised in constant time.

const MAC_BYTES = 24;

/** What signs and finds invite links: the identity secret and the address the links open. */
export interface InviteSigner { secret: string; publicOrigin: string }

function macOf(signer: InviteSigner, id: Buffer): Buffer {
  const key = createHmac('sha256', signer.secret).update('flux-workspace-invite-v1').digest();
  return createHmac('sha256', key).update(id).digest().subarray(0, MAC_BYTES);
}

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const uuidOf = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The link token of an invite id: base64url of the id's 16 bytes and the first 24 bytes of its HMAC. */
export function inviteToken(signer: InviteSigner, inviteId: string): string {
  const id = uuidBytes(inviteId);
  return Buffer.concat([id, macOf(signer, id)]).toString('base64url');
}

export const inviteTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** The invite id a well-formed, genuine token names, or null (checked in constant time). */
export function inviteIdOf(signer: InviteSigner, token: unknown): string | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{54}$/.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 16 + MAC_BYTES) return null;
  const id = bytes.subarray(0, 16);
  return timingSafeEqual(bytes.subarray(16), macOf(signer, id)) ? uuidOf(id) : null;
}
