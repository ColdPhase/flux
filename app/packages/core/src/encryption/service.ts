import { randomUUID, type KeyObject } from 'node:crypto';
import {
  UNLOCK_ATTEMPT_LIMIT, UNLOCK_ATTEMPT_WINDOW_SECONDS, UNLOCK_GRANT_SECONDS, WORKSPACE_LOCKED_EVENT,
  WORKSPACE_UNLOCK_PASSWORD_GRANTED_EVENT, WORKSPACE_UNLOCK_PASSWORD_SET_EVENT, WORKSPACE_UNLOCKED_EVENT,
  type CreateEncryptedWorkspaceCommand, type CreateEncryptedWorkspaceResult, type EncryptionStateResult, type GrantUnlockPasswordCommand,
  type GrantUnlockPasswordResult, type NewRecoveryCodeCommand, type NewRecoveryCodeResult, type SetUnlockPasswordCommand, type UnlockWorkspaceCommand,
} from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, RateLimitedError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { WorkspaceLockedError, UnlockIncorrectError } from './errors.js';
import {
  canonicalVersions, generateHolderKeyPair, holderMac, HolderKeyMismatchError, holderSecretCheck, holderSecretCheckValid, keyCommitmentValid, openDekForHolder, sealDekToHolder,
  unwrapPrivateKey, wrapConfirmation, wrapConfirmationValid, wrapPrivateKey, type HolderKeyPair,
} from './holders.js';
import { deriveKek, kdfIsCurrent, newKdfParams, parseKdfParams, type KdfParams } from './kdf.js';
import { keyCheckValid, keyCheckValue, newDek, WorkspaceKey } from './keys.js';
import { openField } from './envelope.js';
import { holderIdentity, holderPlace as place, holdersValid, recordTampering, SYSTEM, TamperSignal, zero, type Deks } from './holder-set.js';
import { DecryptionFailedError } from './primitives.js';
import { generateRecoveryCode, normalizeRecoveryCode } from './recovery.js';
import { typedSecret, unlockPassword } from './passwords.js';
import { unlockedRows } from './seal-for.js';
import type { DerivationSemaphore } from './semaphore.js';
import type { ProcessKeys } from './process-keys.js';
import type { PasswordEstimator } from './ports.js';
import type { DekWrapRecord, EncryptionPorts, EncryptionUnitOfWork, HolderRecord, KeysRecord, KeyVersionRecord, WorkspaceReader } from './service-ports.js';

/**
 * The unlock lifecycle of encrypted workspaces (F-030, #655, S1; docs/product/encrypted-workspaces.md): creation (a
 * fixture-only route until S3), unlock, Lock now, grants, unlock passwords and the recovery code.
 *
 * - Every route that checks a password or the recovery code shares one limiter (`password_attempts`, five per person
 *   and workspace in 15 minutes, counted with the checks in flight) and one derivation semaphore (two at once).
 * - No transaction waits on anything outside the database: Argon2id and the keyring calls run between short ones.
 * - A DEK is accepted through the holder's own confirmation when one exists (a mismatch is tampering), otherwise only
 *   through the commitment chain, and only if it opens its version's check value; every holder row's MAC must verify
 *   and every password holder must be an owner or admin. Any failure marks the workspace tampered (409
 *   ENCRYPTION_TAMPERED, no unlock row) and tells every holder. The flag is not sticky: every attempt verifies from
 *   scratch, and a passing unlock clears it.
 * - Raw key buffers are zeroed once used; keys live as `KeyObject`s.
 */
export interface EncryptionUseCaseDeps {
  unit: EncryptionUnitOfWork;
  keys: ProcessKeys;
  semaphore: DerivationSemaphore;
  estimator: PasswordEstimator;
  read: WorkspaceReader;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sample = { field: string; identity: string[]; envelope: string } | null;
interface Material {
  keys: KeysRecord; holders: HolderRecord[]; wraps: DekWrapRecord[]; versions: KeyVersionRecord[]; managers: string[];
  /** One stored envelope of each live version whose previous version is no longer live (the post-rotation case). */
  samples: Map<number, Sample>;
}

const sameVersions = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export function createEncryptionUseCases({ unit, keys, semaphore, estimator, read }: EncryptionUseCaseDeps) {
  const person = (principal: Principal) => {
    if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('Only workspace owners and admins can manage encryption', 'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED');
    return principal.id;
  };
  const encryptionOf = async (principal: Principal, workspaceId: string): Promise<EncryptionStateResult> =>
    ({ encryption: (await read(principal, workspaceId)).encryption! });

  async function material(ports: EncryptionPorts, workspaceId: string): Promise<Material> {
    const k = await ports.rows.keys(workspaceId);
    if (!k) throw new ConflictError('This workspace is not encrypted', 'WORKSPACE_NOT_ENCRYPTED');
    const samples = new Map<number, Sample>();
    for (const version of k.liveVersions) {
      if (version > 1 && !k.liveVersions.includes(version - 1)) samples.set(version, await ports.rows.envelopeSample(workspaceId, version));
    }
    return { keys: k, holders: await ports.rows.holders(workspaceId), wraps: await ports.rows.dekWraps(workspaceId),
      versions: await ports.rows.keyVersions(workspaceId), managers: await ports.rows.managers(workspaceId), samples };
  }

  /** Authorizes, then reads what a command needs. */
  async function prepare(principal: Principal, workspaceId: string) {
    return unit.run(async (ports) => {
      const { role } = await ports.access.manager(principal, workspaceId);
      if (!await ports.rows.sealed(workspaceId)) throw new ConflictError('This workspace is not encrypted', 'WORKSPACE_NOT_ENCRYPTED');
      const m = await material(ports, workspaceId);
      const state = await ports.rows.sealState(workspaceId, { lock: false });
      return { role, m, state: state! };
    });
  }

  const tampered = (workspaceId: string, name: string, holders: HolderRecord[]) => recordTampering(unit, workspaceId, name, holders);

  /** A check that cannot succeed (no such holder): it still counts against the limiter. */
  async function refuseCheck(principal: Principal, workspaceId: string, name: string): Promise<never> {
    const reservation = await unit.run((ports) => ports.rows.reserveAttempt(workspaceId, principal.id, UNLOCK_ATTEMPT_LIMIT, UNLOCK_ATTEMPT_WINDOW_SECONDS));
    if ('retryAfterSeconds' in reservation) throw limited(reservation.retryAfterSeconds);
    throw new UnlockIncorrectError(name);
  }
  const limited = (seconds: number) => new RateLimitedError(seconds, 'Too many tries. Try again in 15 minutes.', 'UNLOCK_RATE_LIMITED');

  /**
   * One password or code check: the shared limiter, then Argon2id under the shared semaphore, then the private key.
   * A wrong secret keeps its attempt row (400); a right one releases it. A public key that does not match is tampering.
   */
  async function checkSecret(principal: Principal, m: Material, holder: HolderRecord, secret: string): Promise<{ privateKey: KeyObject; kek: Buffer; kdf: KdfParams }> {
    const workspaceId = m.keys.workspaceId;
    const reservation = await unit.run((ports) => ports.rows.reserveAttempt(workspaceId, principal.id, UNLOCK_ATTEMPT_LIMIT, UNLOCK_ATTEMPT_WINDOW_SECONDS));
    if ('retryAfterSeconds' in reservation) throw limited(reservation.retryAfterSeconds);
    let kdf: KdfParams;
    try { kdf = parseKdfParams(holder.kdf); } catch {
      await unit.run((ports) => ports.rows.releaseAttempt(reservation.id));
      return tampered(workspaceId, m.keys.name, m.holders);
    }
    let kek: Buffer;
    try { kek = await semaphore.run(() => deriveKek(secret, kdf)); } catch (error) {
      await unit.run((ports) => ports.rows.releaseAttempt(reservation.id)); // a busy server is not a wrong guess
      throw error;
    }
    // A wrong secret fails the check (400, the attempt counts). A right one whose row no longer opens was changed outside
    // Flux (a replaced public key or wrapped private key): tampering, and the attempt is released.
    if (!holderSecretCheckValid(kek, place(holder), holder.secretCheck)) {
      kek.fill(0);
      throw new UnlockIncorrectError(m.keys.name);
    }
    await unit.run((ports) => ports.rows.releaseAttempt(reservation.id));
    try {
      return { privateKey: unwrapPrivateKey(kek, holder.wrappedPrivate, place(holder), holder.publicKey), kek, kdf };
    } catch (error) {
      kek.fill(0);
      if (error instanceof HolderKeyMismatchError || error instanceof DecryptionFailedError) return tampered(workspaceId, m.keys.name, m.holders);
      throw error;
    }
  }

  /**
   * Opens and accepts the holder's DEK of every live version, oldest first (Authenticating holders and wraps, order at
   * unlock), then verifies the holder set under the current DEK. Null on any failure (the caller marks tampering).
   * Returns the confirmations this holder still lacks.
   */
  function acceptDeks(m: Material, holder: HolderRecord, privateKey: KeyObject, kek: Buffer): { deks: Deks; confirmations: { keyVersion: number; confirm: string }[] } | null {
    const workspaceId = m.keys.workspaceId;
    const deks: Deks = new Map();
    const confirmations: { keyVersion: number; confirm: string }[] = [];
    const fail = () => { zero(deks); return null; };
    for (const version of [...m.keys.liveVersions].sort((a, b) => a - b)) {
      const wrap = m.wraps.find((row) => row.holderId === holder.id && row.keyVersion === version);
      const kv = m.versions.find((row) => row.keyVersion === version);
      if (!wrap || !kv) return fail();
      const dekPlace = { workspaceId, holderId: holder.id, keyVersion: version };
      let dek: Buffer;
      try { dek = openDekForHolder(privateKey, wrap, dekPlace); } catch { return fail(); }
      // A confirmation, when the holder has one for this version, decides alone: the commitment chain is a MAC under
      // DEK v-1, which an earlier holder may know, so it never overrides the holder's own proof.
      // A version the holder's (MAC-covered) confirmed set lists must still have its confirmation: a deleted one is
      // tampering, never a fall-back to the chain (S2a-1 review).
      if (wrap.confirm === null && holder.confirmedVersions.includes(version)) { dek.fill(0); return fail(); }
      const previous = deks.get(version - 1);
      const key = WorkspaceKey.fromDek(workspaceId, version, dek);
      const accepted = wrap.confirm !== null
        ? wrapConfirmationValid(kek, dekPlace, dek, wrap.confirm)
        : previous ? keyCommitmentValid(previous, workspaceId, version, dek, kv.commitment)
          // After a finished rotation the previous DEK is gone, and a holder who did not unlock during it has no
          // confirmation of the new version: its check value and one stored envelope of it decide (S1 review carry-over).
          : version > 1 && !m.keys.liveVersions.includes(version - 1) && m.samples.has(version) && sampleOpens(key, m.samples.get(version)!);
      if (!accepted || !keyCheckValid(key, kv.checkValue)) { dek.fill(0); return fail(); }
      if (wrap.confirm === null) confirmations.push({ keyVersion: version, confirm: wrapConfirmation(kek, dekPlace, dek) });
      deks.set(version, dek);
    }
    return holdersValid(m, deks) ? { deks, confirmations } : fail();
  }

  /** No sample (nothing of that version stored yet): the check value alone. A sample must open. */
  function sampleOpens(key: WorkspaceKey, sample: Sample): boolean {
    if (!sample) return true;
    try { openField((v) => (v === key.version ? key : undefined), { workspaceId: key.workspaceId, field: sample.field, identity: sample.identity }, sample.envelope); return true; }
    catch { return false; }
  }

  /** A holder's row and DEK wraps (with confirmations) for every live version, under a new KEK. */
  function holderMaterial(workspaceId: string, holderId: string, kind: 'password' | 'recovery', userId: string | null, kek: Buffer, kdf: KdfParams,
    pair: HolderKeyPair, deks: Deks, currentVersion: number, existing?: DekWrapRecord[]) {
    const who = { workspaceId, holderId, kind, userId };
    const wrappedPrivate = wrapPrivateKey(kek, pair, who);
    const secretCheck = holderSecretCheck(kek, who);
    const confirmedVersions = canonicalVersions([...deks.keys()]);
    const holder: HolderRecord = {
      id: holderId, workspaceId, kind, userId, kdf, publicKey: pair.publicKey, wrappedPrivate,
      holderMac: holderMac(deks.get(currentVersion)!, currentVersion, { ...who, publicKey: pair.publicKey, kdf, wrappedPrivate, secretCheck, confirmedVersions }),
      holderMacVersion: currentVersion, secretCheck, confirmedVersions,
    };
    const wraps = [...deks].map(([keyVersion, dek]) => {
      const dekPlace = { workspaceId, holderId, keyVersion };
      const kept = existing?.find((row) => row.keyVersion === keyVersion);
      const box = kept ? { ephemeralPublic: kept.ephemeralPublic, sealedDek: kept.sealedDek } : sealDekToHolder(dek, pair.publicKey, dekPlace);
      return { workspaceId, keyVersion, ...box, confirm: wrapConfirmation(kek, dekPlace, dek) };
    });
    return { holder, wraps };
  }

  /** In a final transaction: the key row locked, the live versions as read, no tampering, and every holder still valid. */
  async function recheck(ports: EncryptionPorts, m: Material, deks: Deks): Promise<void> {
    const k = await ports.rows.keys(m.keys.workspaceId, { lock: 'update' });
    if (!k || !sameVersions(k.liveVersions, m.keys.liveVersions) || k.currentVersion !== m.keys.currentVersion) {
      throw new ConflictError('The workspace keys changed meanwhile; try again', 'ENCRYPTION_CHANGED');
    }
    const holders = await ports.rows.holders(m.keys.workspaceId);
    const wraps = await ports.rows.dekWraps(m.keys.workspaceId);
    if (!holdersValid({ keys: k, holders, wraps, managers: await ports.rows.managers(m.keys.workspaceId) }, deks)) throw new TamperSignal();
  }

  /** Runs a final unit of work; a holder that no longer verifies inside it is recorded as tampering after the rollback. */
  async function finish<T>(m: Material, work: (ports: EncryptionPorts) => Promise<T>): Promise<T> {
    try { return await unit.run(work); } catch (error) {
      if (error instanceof TamperSignal) return tampered(m.keys.workspaceId, m.keys.name, m.holders);
      throw error;
    }
  }

  /** The DEKs of every live version from this process's unlocked keys (the workspace must be unlocked). */
  async function unlockedDeks(principal: Principal, m: Material, state: Awaited<ReturnType<typeof prepare>>['state']): Promise<Deks> {
    const rows = await unlockedRows(state, keys);
    if (!rows) throw new WorkspaceLockedError(m.keys.workspaceId, m.keys.name);
    const deks: Deks = new Map();
    try {
      for (const version of m.keys.liveVersions) deks.set(version, (await keys.key(m.keys.workspaceId, rows.get(version)!)).exportDek());
    } catch {
      zero(deks);
      throw new WorkspaceLockedError(m.keys.workspaceId, m.keys.name);
    }
    if (!holdersValid(m, deks)) { zero(deks); return tampered(m.keys.workspaceId, m.keys.name, m.holders); }
    return deks;
  }

  return {
    /** `POST /api/v1/encrypted-workspaces` (fixture-only until S3). */
    async create(principal: Principal, command: CreateEncryptedWorkspaceCommand): Promise<{ status: 200 | 201; body: CreateEncryptedWorkspaceResult }> {
      if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('Only people can create workspaces');
      const name = typeof command?.name === 'string' ? command.name.trim() : '';
      if (!name || name.length > 200) throw new InvalidInputError('Name must be 1–200 characters');
      if (typeof command.creationId !== 'string' || !UUID.test(command.creationId)) throw new InvalidInputError('creationId must be a UUID');
      const creationId = command.creationId.toLowerCase();
      const again = async () => {
        const existing = await unit.run((ports) => ports.rows.workspaceByCreation(principal.id, creationId));
        if (!existing) return null;
        if (existing.name !== name) throw new ConflictError('This creation id was used for another workspace', 'IDEMPOTENCY_CONFLICT');
        return { status: 200 as const, body: { workspace: await read(principal, existing.id), recoveryCode: null } };
      };
      const retried = await again();
      if (retried) return retried;
      const password = unlockPassword(command.password, estimator);
      keys.requireAvailable();
      const workspaceId = randomUUID();
      const code = generateRecoveryCode();
      const ownerKdf = newKdfParams();
      const recoveryKdf = newKdfParams();
      const ownerKek = await semaphore.run(() => deriveKek(password, ownerKdf));
      const recoveryKek = await semaphore.run(() => deriveKek(normalizeRecoveryCode(code)!, recoveryKdf));
      const deks: Deks = new Map([[1, newDek()]]);
      try {
        const key = WorkspaceKey.fromDek(workspaceId, 1, deks.get(1)!);
        const owner = holderMaterial(workspaceId, randomUUID(), 'password', principal.id, ownerKek, ownerKdf, generateHolderKeyPair(), deks, 1);
        const recovery = holderMaterial(workspaceId, randomUUID(), 'recovery', null, recoveryKek, recoveryKdf, generateHolderKeyPair(), deks, 1);
        const unlock = await keys.sealForUnlock(workspaceId, 1, deks.get(1)!);
        try {
          await unit.run(async (ports) => {
            await ports.rows.insertSealedWorkspace({ id: workspaceId, name, createdBy: principal.id, creationId });
            await ports.rows.insertKeyVersion({ workspaceId, keyVersion: 1, commitment: null, checkValue: keyCheckValue(key) });
            for (const holder of [owner, recovery]) {
              await ports.rows.insertHolder(holder.holder);
              await ports.rows.replaceDekWraps(holder.holder.id, holder.wraps);
            }
            await ports.rows.upsertUnlock(workspaceId, { keyVersion: 1, bootId: unlock.bootId, sealedDek: unlock.sealed, unlockedBy: principal.id });
            await ports.event(principal, workspaceId, 'workspace.created.v1', {});
            await ports.event(principal, workspaceId, WORKSPACE_UNLOCKED_EVENT, { by: principal.id });
          });
        } catch (error) {
          // A concurrent retry with the same creation id won the unique index: answer as its retry.
          const raced = await again().catch(() => null);
          if (raced) return raced;
          throw error;
        }
      } finally {
        zero(deks); ownerKek.fill(0); recoveryKek.fill(0);
      }
      return { status: 201, body: { workspace: await read(principal, workspaceId), recoveryCode: code } };
    },

    /** `POST …/unlock { password } | { recoveryCode }`. Already unlocked under this boot: 200, no check. */
    async unlock(principal: Principal, workspaceId: string, command: UnlockWorkspaceCommand): Promise<EncryptionStateResult> {
      if (!keys.swapSafe) keys.requireAvailable();
      person(principal);
      const { m, state } = await prepare(principal, workspaceId);
      if (await unlockedRows(state, keys)) return encryptionOf(principal, workspaceId);
      keys.requireAvailable();
      const password = command?.password === undefined ? null : typedSecret(command.password);
      const code = command?.recoveryCode === undefined ? null : normalizeRecoveryCode(command.recoveryCode);
      if ((command?.password === undefined) === (command?.recoveryCode === undefined) || (command.password !== undefined && password === null)) {
        throw new InvalidInputError('Send either your unlock password or the recovery code');
      }
      let holder: HolderRecord | undefined;
      if (password !== null) {
        holder = m.holders.find((row) => row.kind === 'password' && row.userId === principal.id);
        if (!holder) throw new ConflictError(`You don't have an unlock password for ${m.keys.name} yet.`, 'NO_UNLOCK_PASSWORD');
      } else {
        holder = m.holders.find((row) => row.kind === 'recovery');
        if (!holder || code === null) return refuseCheck(principal, workspaceId, m.keys.name);
      }
      const { privateKey, kek, kdf } = await checkSecret(principal, m, holder, password ?? code!);
      let accepted: ReturnType<typeof acceptDeks> = null;
      let upgrade: { kek: Buffer; kdf: KdfParams } | null = null;
      try {
        accepted = acceptDeks(m, holder, privateKey, kek);
        if (!accepted) return await tampered(workspaceId, m.keys.name, m.holders);
        if (!kdfIsCurrent(kdf)) {
          const fresh = newKdfParams();
          upgrade = { kek: await semaphore.run(() => deriveKek(password ?? code!, fresh)), kdf: fresh };
        }
        const sealed: { keyVersion: number; bootId: string; sealed: string }[] = [];
        for (const [keyVersion, dek] of accepted.deks) sealed.push({ keyVersion, ...(await keys.sealForUnlock(workspaceId, keyVersion, dek)) });
        const target = holder;
        const deks = accepted.deks;
        const confirmations = accepted.confirmations;
        await finish(m, async (ports) => {
          await recheck(ports, m, deks);
          await ports.access.manager(principal, workspaceId, { lock: true });
          if (upgrade) {
            const pair = { publicKey: target.publicKey, privateKey };
            const fresh = holderMaterial(workspaceId, target.id, target.kind, target.userId, upgrade.kek, upgrade.kdf, pair, deks, m.keys.currentVersion,
              m.wraps.filter((row) => row.holderId === target.id));
            await ports.rows.updateHolder(target.id, fresh.holder);
            await ports.rows.replaceDekWraps(target.id, fresh.wraps);
          } else if (confirmations.length) {
            for (const { keyVersion, confirm } of confirmations) await ports.rows.setConfirm(target.id, keyVersion, confirm);
            // The MAC covers the confirmed set, so it is rewritten with the new confirmations (under the current DEK).
            const confirmedVersions = canonicalVersions([...target.confirmedVersions.filter((v) => m.keys.liveVersions.includes(v)),
              ...confirmations.map((row) => row.keyVersion)]);
            await ports.rows.updateHolderMac(target.id, { confirmedVersions, holderMacVersion: m.keys.currentVersion,
              holderMac: holderMac(deks.get(m.keys.currentVersion)!, m.keys.currentVersion, holderIdentity(target, confirmedVersions)) });
          }
          // Every check passed from scratch: the tampering flag (display and alerting only) is cleared.
          await ports.rows.clearTampered(workspaceId);
          for (const row of sealed) await ports.rows.upsertUnlock(workspaceId, { keyVersion: row.keyVersion, bootId: row.bootId, sealedDek: row.sealed, unlockedBy: principal.id });
          await ports.event(principal, workspaceId, WORKSPACE_UNLOCKED_EVENT, { by: principal.id });
          await ports.resume(workspaceId);
        });
      } finally {
        kek.fill(0); upgrade?.kek.fill(0); zero(accepted?.deks);
      }
      return encryptionOf(principal, workspaceId);
    },

    /** `POST …/lock`: deletes the unlock rows (`FOR UPDATE`), then holds the person's membership `FOR SHARE`. */
    async lock(principal: Principal, workspaceId: string): Promise<EncryptionStateResult> {
      person(principal);
      // Authorised read-only first, so nobody else can contend for the rows; then the rows FOR UPDATE, then the membership.
      await unit.run(async (ports) => { await ports.access.manager(principal, workspaceId); });
      await unit.run(async (ports) => {
        await ports.rows.unlocks(workspaceId, { lock: 'update' });
        await ports.access.manager(principal, workspaceId, { lock: true });
        if (!await ports.rows.sealed(workspaceId)) throw new ConflictError('This workspace is not encrypted', 'WORKSPACE_NOT_ENCRYPTED');
        if (await ports.rows.deleteUnlocks(workspaceId)) await ports.event(principal, workspaceId, WORKSPACE_LOCKED_EVENT, { reason: 'person' });
      });
      keys.forget(workspaceId);
      return encryptionOf(principal, workspaceId);
    },

    /** `POST …/unlock-password-grants { userId, password }`: a holder lets an owner or admin without a password set one, for one hour. */
    async grant(principal: Principal, workspaceId: string, command: GrantUnlockPasswordCommand): Promise<GrantUnlockPasswordResult> {
      person(principal);
      const secret = typedSecret(command?.password);
      if (!secret || typeof command.userId !== 'string' || !command.userId) throw new InvalidInputError('userId and your unlock password are required');
      const { m, state } = await prepare(principal, workspaceId);
      const target = command.userId;
      const own = m.holders.find((row) => row.kind === 'password' && row.userId === principal.id);
      if (!own || target === principal.id || !m.managers.includes(target)) {
        throw new ForbiddenError('Only an owner or admin with an unlock password can let another owner or admin set one', 'UNLOCK_GRANT_FORBIDDEN');
      }
      if (m.holders.some((row) => row.kind === 'password' && row.userId === target)) throw new ConflictError('They already have an unlock password', 'ALREADY_HAS_PASSWORD');
      if (!await unlockedRows(state, keys)) throw new WorkspaceLockedError(workspaceId, m.keys.name);
      const { kek } = await checkSecret(principal, m, own, secret);
      kek.fill(0);
      const expiresAt = await unit.run(async (ports) => {
        await ports.access.manager(principal, workspaceId, { lock: true });
        const at = await ports.rows.putGrant(workspaceId, target, principal.id, UNLOCK_GRANT_SECONDS);
        await ports.event(principal, workspaceId, WORKSPACE_UNLOCK_PASSWORD_GRANTED_EVENT, { userId: target });
        return at;
      });
      return { expiresAt: expiresAt.toISOString() };
    },

    /**
     * `PUT …/unlock-password`: changing needs `currentPassword` or `recoveryCode`; a first password needs a valid grant
     * (while unlocked) or `recoveryCode`. The final transaction takes `workspace_keys` `FOR UPDATE`, re-reads the live
     * versions and verifies the existing holders before writing.
     */
    async setPassword(principal: Principal, workspaceId: string, command: SetUnlockPasswordCommand): Promise<EncryptionStateResult> {
      person(principal);
      const { m, state } = await prepare(principal, workspaceId);
      const newPassword = unlockPassword(command?.newPassword, estimator);
      if (command.currentPassword !== undefined && command.recoveryCode !== undefined) throw new InvalidInputError('Send your current password or the recovery code, not both');
      const own = m.holders.find((row) => row.kind === 'password' && row.userId === principal.id);
      const recovery = m.holders.find((row) => row.kind === 'recovery');
      let deks: Deks | null = null;
      let kept: { privateKey: KeyObject } | null = null;
      let grantPath = false;
      const keks: Buffer[] = [];
      try {
        if (command.currentPassword !== undefined) {
          const secret = typedSecret(command.currentPassword);
          if (!own) throw new ConflictError(`You don't have an unlock password for ${m.keys.name} yet.`, 'NO_UNLOCK_PASSWORD');
          if (!secret) return await refuseCheck(principal, workspaceId, m.keys.name);
          const checked = await checkSecret(principal, m, own, secret);
          keks.push(checked.kek);
          const accepted = acceptDeks(m, own, checked.privateKey, checked.kek);
          if (!accepted) return await tampered(workspaceId, m.keys.name, m.holders);
          deks = accepted.deks;
          kept = { privateKey: checked.privateKey };
        } else if (command.recoveryCode !== undefined) {
          const code = normalizeRecoveryCode(command.recoveryCode);
          if (!recovery || !code) return await refuseCheck(principal, workspaceId, m.keys.name);
          const checked = await checkSecret(principal, m, recovery, code);
          keks.push(checked.kek);
          const accepted = acceptDeks(m, recovery, checked.privateKey, checked.kek);
          if (!accepted) return await tampered(workspaceId, m.keys.name, m.holders);
          deks = accepted.deks;
        } else {
          if (own) throw new InvalidInputError('Changing your unlock password needs your current one or the recovery code', 'CURRENT_PASSWORD_REQUIRED');
          if (!await unit.run((ports) => ports.rows.grant(workspaceId, principal.id))) {
            throw new ForbiddenError('Another owner or admin with an unlock password needs to let you set one, or use the recovery code', 'UNLOCK_PASSWORD_GRANT_REQUIRED');
          }
          deks = await unlockedDeks(principal, m, state);
          grantPath = true;
        }
        const kdf = newKdfParams();
        const kek = await semaphore.run(() => deriveKek(newPassword, kdf));
        keks.push(kek);
        const holderId = own?.id ?? randomUUID();
        const pair = kept && own ? { publicKey: own.publicKey, privateKey: kept.privateKey } : generateHolderKeyPair();
        const fresh = holderMaterial(workspaceId, holderId, 'password', principal.id, kek, kdf, pair, deks, m.keys.currentVersion,
          kept ? m.wraps.filter((row) => row.holderId === holderId) : undefined);
        const usedDeks = deks;
        await finish(m, async (ports) => {
          await ports.access.manager(principal, workspaceId, { lock: true });
          await recheck(ports, m, usedDeks);
          if (grantPath) {
            if (!await ports.rows.grant(workspaceId, principal.id, { lock: true })) {
              throw new ForbiddenError('The permission to set a password has expired; ask again', 'UNLOCK_PASSWORD_GRANT_REQUIRED');
            }
            await ports.rows.deleteGrant(workspaceId, principal.id);
          }
          if (own) await ports.rows.updateHolder(holderId, fresh.holder);
          else await ports.rows.insertHolder(fresh.holder);
          await ports.rows.replaceDekWraps(holderId, fresh.wraps);
          const eventId = await ports.event(principal, workspaceId, WORKSPACE_UNLOCK_PASSWORD_SET_EVENT, { userId: principal.id });
          if (!own) {
            const myName = await ports.rows.userName(principal.id) ?? 'Someone';
            const managers = new Set(await ports.rows.managers(workspaceId));
            for (const holder of await ports.rows.holders(workspaceId)) {
              if (holder.kind !== 'password' || !holder.userId || holder.userId === principal.id || !managers.has(holder.userId)) continue;
              await ports.rows.insertSecurityNotice({ userId: holder.userId, workspaceId, eventId, title: `${myName} now has an unlock password for ${m.keys.name}` });
            }
          }
        });
      } finally {
        for (const kek of keks) kek.fill(0);
        zero(deks);
      }
      return encryptionOf(principal, workspaceId);
    },

    /** `POST …/recovery-code { password }`: owner only, while unlocked; replaces the recovery holder. */
    async newRecoveryCode(principal: Principal, workspaceId: string, command: NewRecoveryCodeCommand): Promise<NewRecoveryCodeResult> {
      person(principal);
      const secret = typedSecret(command?.password);
      if (!secret) throw new InvalidInputError('Your unlock password is required');
      const { role, m, state } = await prepare(principal, workspaceId);
      if (role !== 'owner') throw new ForbiddenError('Only an owner can make a new recovery code', 'OWNER_REQUIRED');
      if (!await unlockedRows(state, keys)) throw new WorkspaceLockedError(workspaceId, m.keys.name);
      const own = m.holders.find((row) => row.kind === 'password' && row.userId === principal.id);
      if (!own) throw new ConflictError(`You don't have an unlock password for ${m.keys.name} yet.`, 'NO_UNLOCK_PASSWORD');
      const keks: Buffer[] = [];
      let deks: Deks | null = null;
      const code = generateRecoveryCode();
      try {
        const checked = await checkSecret(principal, m, own, secret);
        keks.push(checked.kek);
        const accepted = acceptDeks(m, own, checked.privateKey, checked.kek);
        if (!accepted) return await tampered(workspaceId, m.keys.name, m.holders);
        deks = accepted.deks;
        const kdf = newKdfParams();
        const kek = await semaphore.run(() => deriveKek(normalizeRecoveryCode(code)!, kdf));
        keks.push(kek);
        const existing = m.holders.find((row) => row.kind === 'recovery');
        const fresh = holderMaterial(workspaceId, existing?.id ?? randomUUID(), 'recovery', null, kek, kdf, generateHolderKeyPair(), deks, m.keys.currentVersion);
        const usedDeks = deks;
        await finish(m, async (ports) => {
          const again = await ports.access.manager(principal, workspaceId, { lock: true });
          if (again.role !== 'owner') throw new ForbiddenError('Only an owner can make a new recovery code', 'OWNER_REQUIRED');
          await recheck(ports, m, usedDeks);
          if (existing) await ports.rows.updateHolder(existing.id, fresh.holder);
          else await ports.rows.insertHolder(fresh.holder);
          await ports.rows.replaceDekWraps(fresh.holder.id, fresh.wraps);
        });
      } finally {
        for (const kek of keks) kek.fill(0);
        zero(deks);
      }
      return { recoveryCode: code };
    },

    dropStaleUnlocks: (currentBoot: string, observedAt: Date) => dropStaleUnlocks(unit, currentBoot, observedAt),
  };
}
export type EncryptionUseCases = ReturnType<typeof createEncryptionUseCases>;

/**
 * The heartbeat's boot change, in every API and worker process: deletes every stale unlock row and records one
 * `workspace.locked.v1 { reason: 'restart' }` per workspace. Concurrent deleters do no harm (each row is deleted once).
 */
export async function dropStaleUnlocks(unit: EncryptionUnitOfWork, currentBoot: string, observedAt: Date): Promise<string[]> {
  return unit.run(async (ports) => {
    // Only rows written before this process saw the boot: a late heartbeat never deletes rows of a newer boot.
    const dropped = await ports.rows.dropStaleUnlocks(currentBoot, observedAt);
    for (const row of dropped) {
      await ports.event(row.unlockedBy ? { kind: 'human', id: row.unlockedBy } : SYSTEM, row.workspaceId, WORKSPACE_LOCKED_EVENT, { reason: 'restart' });
    }
    return dropped.map((row) => row.workspaceId);
  });
}
