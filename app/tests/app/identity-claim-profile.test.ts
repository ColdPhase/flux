import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { profileFromClaims, providerFamily } from '../../apps/server/src/identity/claim-profile.js';

// Claim rules for the chosen provider (F-024 S5b, #315, AC-3). The claim sets below are written from the providers'
// documented claim names (OpenID Connect core; Microsoft Entra ID optional claims `tid`, `xms_edov`; Google's `hd` and
// `email_verified`). They are documented shapes, not tokens captured from a real tenant or account: real-provider
// compatibility stays unverified until a recorded integration run exists.
const tid = '6f1c2b3a-0000-4000-8000-000000000001';
const entraIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
const entra = {
  iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, sub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', oid: '00000000-0000-0000-0000-000000000002',
  email: 'Nina.Kowal@Contoso.example', xms_edov: true, name: 'Nina Kowal',
};

describe('provider families', () => {
  test('issuers select the adapter', () => {
    assert.equal(providerFamily(entraIssuer), 'entra');
    assert.equal(providerFamily('https://login.microsoftonline.com/common/v2.0'), 'entra');
    assert.equal(providerFamily('https://accounts.google.com'), 'google');
    assert.equal(providerFamily('https://id.example.org/realms/flux'), 'generic');
    assert.equal(providerFamily('not a url'), 'generic');
  });
});

describe('generic OpenID Connect claims', () => {
  const issuer = 'https://id.example.org/realms/flux';
  test('a verified address from the configured issuer is accepted, lower-cased, with its subject', () => {
    assert.deepEqual(profileFromClaims(issuer, { iss: `${issuer}/`, sub: 'sub-1', email: ' Alice@Acme.test ', email_verified: true, name: 'Alice' }),
      { ok: true, subject: 'sub-1', email: 'alice@acme.test', name: 'Alice' });
  });
  test('an unverified address, another issuer, or no subject is refused', () => {
    assert.equal(profileFromClaims(issuer, { iss: issuer, sub: 'sub-1', email: 'a@acme.test', email_verified: false }).ok, false);
    assert.deepEqual(profileFromClaims(issuer, { iss: 'https://evil.example', sub: 'sub-1', email: 'a@acme.test', email_verified: true }), { ok: false, reason: 'issuer' });
    assert.deepEqual(profileFromClaims(issuer, { iss: issuer, email: 'a@acme.test', email_verified: true }), { ok: false, reason: 'subject' });
  });
});

describe('Microsoft Entra ID claims', () => {
  test('the token tenant must name its own issuer, and a configured single tenant must match', () => {
    assert.deepEqual(profileFromClaims(entraIssuer, entra), { ok: true, subject: entra.sub, email: 'nina.kowal@contoso.example', name: 'Nina Kowal' });
    assert.deepEqual(profileFromClaims(entraIssuer, { ...entra, iss: 'https://login.microsoftonline.com/other-tenant/v2.0' }), { ok: false, reason: 'tenant' });
    assert.deepEqual(profileFromClaims(entraIssuer, { ...entra, tid: undefined }), { ok: false, reason: 'tenant' });
    assert.deepEqual(profileFromClaims('https://login.microsoftonline.com/common/v2.0', entra).ok, true, 'a multi-tenant issuer accepts the token tenant');
    assert.deepEqual(profileFromClaims('https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0', entra), { ok: false, reason: 'tenant' },
      'a single-tenant configuration refuses another tenant');
  });
  test('without the domain-owner claim the address is not verified, so the sign-in is refused', () => {
    assert.deepEqual(profileFromClaims(entraIssuer, { ...entra, xms_edov: undefined, email_verified: true }), { ok: false, reason: 'unverified' });
    assert.deepEqual(profileFromClaims(entraIssuer, { ...entra, xms_edov: false }), { ok: false, reason: 'unverified' });
  });
  test('without an address there is nothing to match, and the subject is still the pairwise sub', () => {
    assert.deepEqual(profileFromClaims(entraIssuer, { ...entra, email: undefined }), { ok: false, reason: 'email' });
  });
});

describe('Google claims', () => {
  const issuer = 'https://accounts.google.com';
  const google = { iss: 'https://accounts.google.com', sub: '104928374650123456789', email: 'ola@studio.example', email_verified: true, hd: 'studio.example' };
  test('a verified Workspace address on the allowed domain is accepted', () => {
    assert.deepEqual(profileFromClaims(issuer, google, { allowedDomain: 'studio.example' }), { ok: true, subject: google.sub, email: 'ola@studio.example', name: null });
  });
  test('the hosted domain must match when one is allowed; a personal account has no hd and is refused then', () => {
    assert.deepEqual(profileFromClaims(issuer, { ...google, hd: 'other.example' }, { allowedDomain: 'studio.example' }), { ok: false, reason: 'domain' });
    assert.deepEqual(profileFromClaims(issuer, { ...google, hd: undefined }, { allowedDomain: 'studio.example' }), { ok: false, reason: 'domain' });
  });
  test('without an allowed domain any verified Google address is accepted; an unverified one never is', () => {
    assert.equal(profileFromClaims(issuer, { ...google, hd: undefined }).ok, true);
    assert.deepEqual(profileFromClaims(issuer, { ...google, email_verified: false }), { ok: false, reason: 'unverified' });
  });
});
