import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test } from 'node:test';
import {
  DecryptionFailedError, DerivationSemaphore, deriveKek, encodeContext, envelopeVersion, fileEncryptor, fileObjectVersion, generateHolderKeyPair,
  generateRecoveryCode, holderMac, holderMacValid, HolderKeyMismatchError, identitySeal, isEnvelope, isSealedJson, keyCheckValid, keyCheckValue,
  keyCommitment, keyCommitmentValid, newDek, newKdfParams, normalizeRecoveryCode, openDekForHolder, openField, openFileObject, parseKdfParams,
  realSeal, redactedError, sealDekToHolder, sealedDigest, sealedJson, sealField, sealFileObject, unlockPassword, unwrapPrivateKey,
  wrapConfirmation, wrapConfirmationValid, wrapPrivateKey, WorkspaceKey, ProcessKeys, sealFor, type FieldPlace, type KdfParams, type KeyringPort,
  type SealStateReader, holderSecretCheck, holderSecretCheckValid,
} from '@flux/core';

// AC-1 of F-030 (#655, S1; docs/product/encrypted-workspaces.md#tests-and-acceptance-criteria): the crypto library.
// Pure: no database, keyring or network.

const ws = randomUUID();
const other = randomUUID();
const dek = newDek();
const key = WorkspaceKey.fromDek(ws, 1, dek);
const keyFor = (k: WorkspaceKey) => (version: number) => (version === k.version ? k : undefined);
const place: FieldPlace = { workspaceId: ws, field: 'project_messages.body', identity: [randomUUID()] };
// Cheap KDF parameters for the tests that are about wrapping, not cost (the cost is asserted separately).
const fastKdf = (): KdfParams => ({ ...newKdfParams(), m: 8_192, t: 1, p: 1 });

describe('F-030 crypto: field envelope', () => {
  test('round trip; the envelope names its key version; lengths are plaintext + 28 bytes', () => {
    const text = 'Garden club meets on Thursday ✓';
    const envelope = sealField(key, place, text);
    assert.ok(envelope.startsWith('fx1.1.'));
    assert.equal(envelopeVersion(envelope), 1);
    assert.ok(isEnvelope(envelope));
    assert.equal(openField(keyFor(key), place, envelope), text);
    assert.equal(Buffer.from(envelope.slice('fx1.1.'.length), 'base64url').length, Buffer.byteLength(text) + 28);
    assert.notEqual(sealField(key, place, text), envelope, 'a random nonce: equal inputs give different values');
    assert.ok(isSealedJson(sealedJson(envelope)));
    assert.equal(isSealedJson({ $sealed: 'plain text' }), false);
  });

  test('a value moved to another row, column, table or workspace fails, as do a tampered tag, a wrong version and a wrong DEK', () => {
    const envelope = sealField(key, place, 'secret plan');
    const moved: FieldPlace[] = [
      { ...place, identity: [randomUUID()] },
      { ...place, field: 'project_messages.title' },
      { ...place, field: 'dm_messages.body' },
      { ...place, workspaceId: other },
      { ...place, identity: [...place.identity, ''] },
    ];
    for (const target of moved) assert.throws(() => openField(keyFor(key), target, envelope), DecryptionFailedError, JSON.stringify(target));
    const otherKey = WorkspaceKey.fromDek(other, 1, dek);
    assert.throws(() => openField(keyFor(otherKey), { ...place, workspaceId: other }, envelope), DecryptionFailedError, 'same DEK, other workspace');
    const bytes = Buffer.from(envelope.slice(6), 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    assert.throws(() => openField(keyFor(key), place, `fx1.1.${bytes.toString('base64url')}`), DecryptionFailedError, 'tampered tag');
    const v2 = WorkspaceKey.fromDek(ws, 2, dek);
    assert.throws(() => openField((version) => (version === 2 ? v2 : undefined), place, envelope.replace('fx1.1.', 'fx1.2.')), DecryptionFailedError,
      'relabelled version (the version is in the AAD and the subkey)');
    const wrong = WorkspaceKey.fromDek(ws, 1, newDek());
    assert.throws(() => openField(keyFor(wrong), place, envelope), DecryptionFailedError, 'wrong DEK');
    assert.throws(() => openField(keyFor(key), place, 'not an envelope'), DecryptionFailedError);
  });

  test('no identity can make sealing throw: an AAD past the 1024-byte HKDF info limit still seals, opens and stays bound (S1 review)', () => {
    // The longest identity a client can choose: a 255-character Idempotency-Key, with a long principal and operation.
    const longKey = 'k'.repeat(255);
    const identity = [`human:${'u'.repeat(400)}`, 'o'.repeat(300), longKey];
    const at = { workspaceId: ws, field: 'idempotency_keys.response_body', identity };
    const envelope = sealField(key, at, 'canary body');
    assert.equal(openField(keyFor(key), at, envelope), 'canary body');
    assert.throws(() => openField(keyFor(key), { ...at, identity: [identity[0]!, identity[1]!, `${longKey.slice(1)}x`] }, envelope), DecryptionFailedError,
      'a long identity is bound in full, not only through its hash');
    const seal = realSeal(ws, 1, new Map([[1, key]]));
    assert.ok(seal.digestMatches('idempotency_keys.request_hash', identity, seal.digest('idempotency_keys.request_hash', identity, 'body'), 'body'));
  });

  test('context encoding: no separator can make two identities equal', () => {
    assert.notDeepEqual(encodeContext(['a', 'bc']), encodeContext(['ab', 'c']));
    assert.notDeepEqual(encodeContext(['a\u0000b']), encodeContext(['a', 'b']));
    const a = sealField(key, { ...place, identity: ['x', 'yz'] }, 'v');
    assert.throws(() => openField(keyFor(key), { ...place, identity: ['xy', 'z'] }, a), DecryptionFailedError);
  });

  test('sealed digest: a round trip compares equal in RAM; equal inputs give different stored values; never the bare SHA-256', () => {
    const seal = realSeal(ws, 1, new Map([[1, key]]));
    const identity = [randomUUID()];
    const one = sealedDigest(seal, 'project_files.sha256', identity, 'leaked.pdf bytes');
    const two = sealedDigest(seal, 'project_files.sha256', identity, 'leaked.pdf bytes');
    assert.notEqual(one, two);
    assert.ok(seal.digestMatches('project_files.sha256', identity, one, 'leaked.pdf bytes'));
    assert.equal(seal.digestMatches('project_files.sha256', identity, one, 'other bytes'), false);
    assert.equal(seal.digestMatches('project_files.sha256', [randomUUID()], one, 'leaked.pdf bytes'), false);
    const plain = identitySeal(ws);
    assert.match(plain.digest('project_files.sha256', identity, 'x'), /^[0-9a-f]{64}$/);
    assert.equal(one.includes(plain.digest('project_files.sha256', identity, 'leaked.pdf bytes')), false);
  });
});

describe('F-030 crypto: files', () => {
  test('streamed object round trip; truncation and tampering are refused before any byte is returned', async () => {
    const fileId = randomUUID();
    const plaintext = randomBytes(300_000);
    const object = await buffer(Readable.from([plaintext.subarray(0, 1000), plaintext.subarray(1000)]).pipe(fileEncryptor(key, fileId)));
    assert.equal(object.subarray(0, 4).toString('ascii'), 'FXF1');
    assert.equal(fileObjectVersion(object), 1);
    assert.deepEqual(openFileObject(keyFor(key), ws, fileId, object), plaintext);
    assert.deepEqual(openFileObject(keyFor(key), ws, fileId, sealFileObject(key, fileId, plaintext)), plaintext);
    assert.throws(() => openFileObject(keyFor(key), ws, fileId, object.subarray(0, object.length - 1)), DecryptionFailedError, 'truncated');
    const tampered = Buffer.from(object);
    tampered[100]! ^= 1;
    assert.throws(() => openFileObject(keyFor(key), ws, fileId, tampered), DecryptionFailedError, 'tampered');
    assert.throws(() => openFileObject(keyFor(key), ws, randomUUID(), object), DecryptionFailedError, 'another file id');
    assert.equal(fileObjectVersion(plaintext), null);
    const empty = await buffer(Readable.from([]).pipe(fileEncryptor(key, fileId)));
    assert.deepEqual(openFileObject(keyFor(key), ws, fileId, empty), Buffer.alloc(0));
  });
});

describe('F-030 crypto: holders, wraps and their authentication', () => {
  const holder = { workspaceId: ws, holderId: randomUUID(), kind: 'password' as const, userId: 'user-ada' };

  test('the KDF uses the stored parameters (RFC 9106 second option by default) and a wrong password fails the tag', async () => {
    const defaults = newKdfParams();
    assert.deepEqual({ m: defaults.m, t: defaults.t, p: defaults.p, alg: defaults.alg }, { m: 65_536, t: 3, p: 4, alg: 'argon2id' });
    assert.equal(Buffer.from(defaults.salt, 'base64url').length, 16);
    assert.deepEqual(parseKdfParams(JSON.parse(JSON.stringify(defaults))), defaults);
    assert.throws(() => parseKdfParams({ ...defaults, m: 1 << 30 }), 'unbounded memory is refused');
    // The bounds (S1 review P3): each parameter at its limit passes, one step past it is refused, and so is any other shape.
    for (const edge of [{ m: 8_192 }, { m: 65_536 }, { t: 1 }, { t: 3 }, { p: 1 }, { p: 4 }]) assert.doesNotThrow(() => parseKdfParams({ ...defaults, ...edge }), JSON.stringify(edge));
    for (const past of [{ m: 8_191 }, { m: 65_537 }, { t: 0 }, { t: 4 }, { p: 0 }, { p: 5 }, { m: 16_384.5 }, { t: '3' }, { alg: 'argon2i' }, { v: 16 },
      { salt: Buffer.alloc(15).toString('base64url') }, { salt: Buffer.alloc(17).toString('base64url') }, { salt: 'not base64url!' }]) {
      assert.throws(() => parseKdfParams({ ...defaults, ...past }), JSON.stringify(past));
    }
    for (const shape of [null, undefined, 'argon2id', [], {}]) assert.throws(() => parseKdfParams(shape), String(shape));
    const params = fastKdf();
    const kek = await deriveKek('river planet mango violin stone cloud', params);
    assert.deepEqual(await deriveKek('river planet mango violin stone cloud', params), kek, 'deterministic for the stored parameters');
    assert.notDeepEqual(await deriveKek('river planet mango violin stone cloud', { ...params, t: 2 }), kek, 'the parameters are used');
    assert.deepEqual(await deriveKek('café river planet mango violin', params), await deriveKek('café river planet mango violin', params), 'NFC');
    const pair = generateHolderKeyPair();
    const wrapped = wrapPrivateKey(kek, pair, holder);
    const opened = unwrapPrivateKey(kek, wrapped, holder, pair.publicKey);
    assert.equal(opened.asymmetricKeyType, 'x25519');
    assert.throws(() => unwrapPrivateKey(Buffer.from(kek).fill(7), wrapped, holder, pair.publicKey), DecryptionFailedError, 'wrong password');
    assert.throws(() => unwrapPrivateKey(kek, wrapped, { ...holder, holderId: randomUUID() }, pair.publicKey), DecryptionFailedError, 'another holder row');
    // The public key is in the AAD: a replaced public key makes the real holder's unlock fail loudly.
    assert.throws(() => unwrapPrivateKey(kek, wrapped, holder, generateHolderKeyPair().publicKey), DecryptionFailedError, 'replaced public key');
    // And a row whose stored public key is consistent with the AAD but not with the private key is tampering.
    const forged = generateHolderKeyPair();
    assert.throws(() => unwrapPrivateKey(kek, wrapPrivateKey(kek, { publicKey: forged.publicKey, privateKey: pair.privateKey }, holder), holder, forged.publicKey),
      HolderKeyMismatchError);
  });

  test('a DEK sealed to a holder opens with its private key; the wrong holder, version or a changed ephemeral key fails', () => {
    const pair = generateHolderKeyPair();
    const dekPlace = { workspaceId: ws, holderId: holder.holderId, keyVersion: 1 };
    const box = sealDekToHolder(dek, pair.publicKey, dekPlace);
    assert.deepEqual(openDekForHolder(pair.privateKey, box, dekPlace), dek);
    assert.throws(() => openDekForHolder(generateHolderKeyPair().privateKey, box, dekPlace), DecryptionFailedError, 'wrong holder key');
    assert.throws(() => openDekForHolder(pair.privateKey, box, { ...dekPlace, holderId: randomUUID() }), DecryptionFailedError, 'another holder id');
    assert.throws(() => openDekForHolder(pair.privateKey, box, { ...dekPlace, keyVersion: 2 }), DecryptionFailedError, 'wrong version');
    assert.throws(() => openDekForHolder(pair.privateKey, { ...box, ephemeralPublic: generateHolderKeyPair().publicKey }, dekPlace), DecryptionFailedError,
      'changed ephemeral key');
    assert.throws(() => openDekForHolder(pair.privateKey, box, { ...dekPlace, workspaceId: other }), DecryptionFailedError, 'another workspace');
  });

  test('holder MAC, confirmation, commitment chain and check value each reject a changed value', async () => {
    const pair = generateHolderKeyPair();
    const identity = { ...holder, publicKey: pair.publicKey, kdf: fastKdf(), wrappedPrivate: 'wrapped-private', secretCheck: 'secret-check' };
    const mac = holderMac(dek, 1, identity);
    assert.ok(holderMacValid(dek, 1, identity, mac));
    assert.ok(holderMacValid(dek, 1, { ...identity, kdf: Object.fromEntries(Object.entries(identity.kdf).reverse()) }, mac), 'jsonb key order does not matter');
    for (const changed of [{ ...identity, publicKey: generateHolderKeyPair().publicKey }, { ...identity, userId: 'user-mallory' },
      { ...identity, kind: 'recovery' as const }, { ...identity, holderId: randomUUID() }, { ...identity, kdf: { ...identity.kdf, m: 16_384 } },
      { ...identity, kdf: { ...identity.kdf, salt: fastKdf().salt } }, { ...identity, wrappedPrivate: 'wrapped-other' }, { ...identity, secretCheck: 'check-other' }]) {
      assert.equal(holderMacValid(dek, 1, changed, mac), false, JSON.stringify(changed));
    }
    assert.equal(holderMacValid(dek, 2, identity, mac), false, 'another MAC version');
    assert.equal(holderMacValid(newDek(), 1, identity, mac), false, 'another DEK');

    const kek = await deriveKek('seven brisk otters juggle neon lanterns', fastKdf());
    const dekPlace = { workspaceId: ws, holderId: holder.holderId, keyVersion: 1 };
    const confirm = wrapConfirmation(kek, dekPlace, dek);
    assert.ok(wrapConfirmationValid(kek, dekPlace, dek, confirm));
    assert.equal(wrapConfirmationValid(kek, dekPlace, newDek(), confirm), false, 'an attacker DEK in a valid box');
    assert.equal(wrapConfirmationValid(kek, { ...dekPlace, keyVersion: 2 }, dek, confirm), false);
    assert.equal(wrapConfirmationValid(Buffer.alloc(32, 1), dekPlace, dek, confirm), false, 'not written by the password holder');

    const dek2 = newDek();
    const commitment = keyCommitment(dek, ws, 2, dek2);
    assert.ok(keyCommitmentValid(dek, ws, 2, dek2, commitment));
    assert.equal(keyCommitmentValid(dek, ws, 2, newDek(), commitment), false, 'a substituted DEK v2');
    assert.equal(keyCommitmentValid(newDek(), ws, 2, dek2, commitment), false, 'not from DEK v1');
    assert.equal(keyCommitmentValid(dek, other, 2, dek2, commitment), false);
    assert.throws(() => keyCommitment(dek, ws, 1, dek2), 'version 1 has no commitment');

    const secretCheck = holderSecretCheck(kek, holder);
    assert.ok(holderSecretCheckValid(kek, holder, secretCheck));
    assert.equal(holderSecretCheckValid(Buffer.alloc(32, 2), holder, secretCheck), false, 'a wrong password');
    assert.equal(holderSecretCheckValid(kek, { ...holder, userId: 'user-mallory' }, secretCheck), false, 'another holder');

    const check = keyCheckValue(key);
    assert.ok(keyCheckValid(key, check));
    assert.equal(keyCheckValid(WorkspaceKey.fromDek(ws, 1, newDek()), check), false);
    assert.equal(keyCheckValid(key, sealField(key, { workspaceId: ws, field: 'workspace_key_versions.check_value', identity: ['1'] }, 'other')), false);
  });

  test('the recovery code: 160 bits in 8 groups of four, normalised (case, spaces, hyphens, O→0, I/L→1)', () => {
    const code = generateRecoveryCode();
    assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const canonical = code.replace(/-/g, '');
    assert.equal(normalizeRecoveryCode(code), canonical);
    assert.equal(normalizeRecoveryCode(` ${code.toLowerCase().replace(/-/g, ' ')} `), canonical);
    assert.equal(normalizeRecoveryCode('O0IL'.repeat(8)), '0011'.repeat(8));
    assert.equal(normalizeRecoveryCode('U'.repeat(32)), null, 'U is not in the alphabet');
    assert.equal(normalizeRecoveryCode(canonical.slice(1)), null);
    assert.notEqual(generateRecoveryCode(), code);
  });
});

describe('F-030 crypto: passwords, semaphore and redaction', () => {
  const estimator = { guessesLog10: (password: string) => (password.includes('abcdefgh') ? 4 : 30) };
  test('own unlock passwords need 20 characters and 10^17 estimated guesses', () => {
    assert.throws(() => unlockPassword('short phrase here', estimator), { code: 'PASSWORD_TOO_WEAK' });
    assert.throws(() => unlockPassword('abcdefghabcdefghabcd', estimator), { code: 'PASSWORD_TOO_WEAK' });
    assert.throws(() => unlockPassword('x'.repeat(25), { guessesLog10: () => 16.9 }), { code: 'PASSWORD_TOO_WEAK' });
    assert.equal(unlockPassword('café river planet mango violin', estimator), 'café river planet mango violin');
  });

  test('two derivations at once; the ninth waiting request is refused with 503 UNLOCK_BUSY', async () => {
    const semaphore = new DerivationSemaphore(2, 8);
    const releases: (() => void)[] = [];
    let running = 0; let peak = 0;
    const work = () => semaphore.run(() => new Promise<void>((resolve) => { running += 1; peak = Math.max(peak, running);
      releases.push(() => { running -= 1; resolve(); }); }));
    const started = Array.from({ length: 10 }, () => work());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(semaphore.load, { active: 2, waiting: 8 });
    await assert.rejects(work(), { code: 'UNLOCK_BUSY', status: 503 });
    while (releases.length) { releases.shift()!(); await new Promise((resolve) => setImmediate(resolve)); }
    await Promise.all(started);
    assert.equal(peak, 2);
    assert.deepEqual(semaphore.load, { active: 0, waiting: 0 });
  });

  test('redactedError keeps the class, code, SQLSTATE, constraint and ids, never the message or detail', () => {
    const error = Object.assign(new Error('duplicate key value violates unique constraint: Key (body)=(CANARY-secret plan)'), {
      code: '23505', constraint: 'project_messages_body_check', detail: 'Key (body)=(CANARY-secret plan) already exists',
    });
    const id = randomUUID();
    const redacted = redactedError(error, [id, 'CANARY-not-an-id']);
    assert.deepEqual({ ...redacted, message: undefined }, { name: 'Error', code: null, sqlState: '23505', constraint: 'project_messages_body_check', ids: [id], message: undefined });
    assert.equal(JSON.stringify(redacted).includes('CANARY'), false);
    assert.equal(redactedError(Object.assign(new Error('x CANARY'), { code: 'WORKSPACE_LOCKED' })).code, 'WORKSPACE_LOCKED');
  });
});

describe('F-030 process keys: the heartbeat re-checks swap', () => {
  test('swap that becomes possible drops every key, refuses new ones and locks the workspace here; safe again, keys are reopened', async () => {
    const workspaceId = randomUUID();
    const bootId = randomUUID();
    let opens = 0;
    const keyring: KeyringPort = {
      boot: async () => bootId,
      seal: async () => ({ bootId, sealed: 'x' }),
      open: async () => { opens += 1; return Buffer.from(dek); },
    };
    let safe = true;
    const keys = new ProcessKeys(keyring, () => (safe ? { safe: true, via: 'cgroup' } : { safe: false, reason: 'swap on' }));
    const forgotten: (string | null)[] = [];
    keys.onForget((id) => forgotten.push(id));
    await keys.refresh();
    assert.equal(keys.availability, 'ok');
    const row = { keyVersion: 1, bootId, sealedDek: 'sealed', unlockedAt: new Date(), unlockedBy: null };
    const reader: SealStateReader = { sealState: async () => ({ name: 'Garden club', encrypted: true, tampered: false, currentVersion: 1, liveVersions: [1], unlocks: [row] }) };
    assert.equal((await sealFor(reader, keys, workspaceId, { write: true })).sealed, true);
    await keys.key(workspaceId, row);
    assert.equal(opens, 1, 'cached');

    safe = false;
    forgotten.length = 0;
    await keys.refresh();
    assert.equal(keys.availability, 'swap_unsafe');
    assert.deepEqual(forgotten, [null], 'every key dropped, listeners told');
    await assert.rejects(keys.key(workspaceId, row));
    await assert.rejects(sealFor(reader, keys, workspaceId, { write: false }), { status: 423, code: 'WORKSPACE_LOCKED' });
    assert.throws(() => keys.requireAvailable(), { code: 'SWAP_UNSAFE' });
    assert.equal(opens, 1, 'nothing opened while unsafe');

    safe = true;
    await keys.refresh();
    await keys.key(workspaceId, row);
    assert.equal(opens, 2, 'the cache was emptied, so the key is opened again');
  });

  test('a keyring that does not answer is not asked again within two seconds (no timeout per request)', async () => {
    let calls = 0;
    const keys = new ProcessKeys({ boot: async () => { calls += 1; throw new Error('down'); }, seal: async () => { throw new Error('down'); },
      open: async () => { throw new Error('down'); } }, () => ({ safe: true, via: 'cgroup' }));
    await keys.refresh(); await keys.refresh(); await keys.refresh();
    assert.equal(calls, 1);
    await keys.refresh({ force: true });
    assert.equal(calls, 2, 'the heartbeat always asks');
    assert.equal(keys.availability, 'keyring_unavailable');
  });
});
