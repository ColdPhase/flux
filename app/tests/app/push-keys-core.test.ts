import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { isP256PublicKey, isPushAuthSecret } from '@flux/core';

describe('Web Push key checks (core)', () => {
  test('isP256PublicKey accepts a real P-256 public key', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const key = ecdh.getPublicKey().toString('base64url');
    assert.equal(isP256PublicKey(key), true);
  });

  test('isP256PublicKey refuses a 64-byte value', () => {
    assert.equal(isP256PublicKey(randomBytes(64).toString('base64url')), false);
  });

  test('isP256PublicKey refuses a 66-byte value', () => {
    assert.equal(isP256PublicKey(randomBytes(66).toString('base64url')), false);
  });

  test('isP256PublicKey refuses a 65-byte value whose first byte is not 0x04', () => {
    const bytes = randomBytes(65);
    bytes[0] = 0x00;
    assert.equal(isP256PublicKey(bytes.toString('base64url')), false);
  });

  test('isP256PublicKey refuses the empty string', () => {
    assert.equal(isP256PublicKey(''), false);
  });

  test('isP256PublicKey refuses standard base64 characters (+ or /)', () => {
    assert.equal(isP256PublicKey('AAAA+AAA/AAA'), false);
  });

  test('isP256PublicKey refuses a value with whitespace', () => {
    assert.equal(isP256PublicKey(' AAAA'), false);
    assert.equal(isP256PublicKey('AAAA '), false);
  });

  test('isPushAuthSecret accepts 16 random bytes in base64url (unpadded)', () => {
    assert.equal(isPushAuthSecret(randomBytes(16).toString('base64url')), true);
  });

  test('isPushAuthSecret accepts 16 random bytes with = padding', () => {
    const value = randomBytes(16).toString('base64url') + '==';
    assert.equal(isPushAuthSecret(value), true);
  });

  test('isPushAuthSecret refuses 15 bytes', () => {
    assert.equal(isPushAuthSecret(randomBytes(15).toString('base64url')), false);
  });

  test('isPushAuthSecret refuses 17 bytes', () => {
    assert.equal(isPushAuthSecret(randomBytes(17).toString('base64url')), false);
  });

  test('isPushAuthSecret refuses the empty string', () => {
    assert.equal(isPushAuthSecret(''), false);
  });

  test('isPushAuthSecret refuses characters outside the base64url alphabet', () => {
    assert.equal(isPushAuthSecret('abc+def/ghi'), false);
    assert.equal(isPushAuthSecret('abc def'), false);
  });
});
