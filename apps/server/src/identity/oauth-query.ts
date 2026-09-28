import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

/**
 * Better Auth 1.7.6 signs its redirect query, but does not export its verifier.
 * Keep this in sync with the pinned provider's signed-query canonicalization.
 */
export async function verifiedOauthQuery(raw: string, secret: string): Promise<URLSearchParams | null> {
  if (!raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const signatures = params.getAll('sig');
  const expiry = Number(params.get('exp'));
  if (signatures.length !== 1 || !signatures[0] || !Number.isFinite(expiry) || expiry * 1000 < Date.now()) return null;
  params.delete('sig');
  const canonical = new URLSearchParams([...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
    keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0));
  const expected = await makeSignature(canonical.toString(), secret);
  return constantTimeEqual(signatures[0], expected) ? params : null;
}
