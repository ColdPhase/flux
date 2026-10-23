# F-030 — encrypted workspaces

**Status: proposed.** The contract waits for one independent peer assessment and is then
implemented in the [slices](#delivery-slices) below. Owner @PelikanFix16 (`claude-hubert`);
independent evaluator @Zamojski5. Issue [#655](https://github.com/ColdPhase/flux/issues/655)
(founder direction, Hubert, 2026-10-23, required in v0.1.0). Decision row: [F-030](decisions.md).
It replaces the set-aside full E2EE research ([#615](https://github.com/ColdPhase/flux/issues/615)), which
recorded no decision. The [founder answers](#founder-answers-2026-10-23) are fixed. The engineering
choices below are the agents' under the [delegation](autonomy.md).

When the owner creates a new workspace, they can turn on **encryption**. It is optional and
cannot be undone. Each encrypted workspace has its own key. Its content is encrypted in the
database, in the files volume and in the search index, and nothing inside it is written to disk
in plaintext. After every start of the server the workspace is **locked** until an owner or
admin enters their unlock password. The key then lives only in RAM. An encrypted workspace is
**always without AI**: the [F-029 AI lock](workspace-ai-lock.md) is forced on and cannot be
turned off. Only people work there.

The contract was written against `main` at `3bbae96a` (2026-10-23). File and function names are
from that revision, and paths are relative to `app/`. An implementer who finds another column, job
or path that carries workspace content adds it to the [inventory](#inventory) in the same PR.

## Threat model

| | Covered | Not covered |
| --- | --- | --- |
| **The adversary has** | A copy of the database (dump, volume, WAL, a backup archive), the files volume, the container logs, or the whole server taken away powered off. | A running, unlocked server: root on the host, a debugger in a process, or a memory snapshot of a live VM. Such an attacker can read RAM, where the unlocked key and plaintext live. This is accepted by founder answer 1. |
| **Guarantee** | Without an unlock password or the recovery code, no workspace content can be read from what is on disk. Ciphertext moved between rows, columns, tables or workspaces fails to decrypt. | Tampering by someone who can write to the database: a field rolled back to an older ciphertext of the **same** row and column is not detected. Theft only reads data; tampering is outside the founder's threat. |
| **Visible** | The [metadata](#what-stays-visible-metadata) listed below: ids, structure, people, times, task status, owner and due date, and value lengths. | — |

Account data (names, e-mail addresses, sessions, passwords managed by Better Auth) is not
workspace content and is unchanged. Live audio and video are not stored ([live media](../development/live-media.md)).

## Terms

- **Sealed workspace.** A workspace with `workspaces.encrypted = true`. "Encrypted workspace" in the
  UI and "sealed" in code mean the same thing.
- **DEK.** The workspace data key: 32 random bytes, created once in the API that creates the
  workspace. It never reaches PostgreSQL or a disk unwrapped.
- **Wrap.** The DEK encrypted under a key derived from one person's unlock password, or from the
  recovery code.
- **Keyring.** A new process that holds one random **boot key** in RAM only (see
  [unlock lifecycle](#unlock-lifecycle-across-processes)).
- **Unlock row.** The DEK sealed under the boot key, stored in `workspace_unlocks`. While a current
  row exists, the workspace is unlocked.
- **Seal / open.** To encrypt or decrypt one value. **Envelope** is the stored ciphertext format.

## Data model

Migration `0118_encrypted_workspaces.sql` (the next free number when S1 lands; later slices take
the next ones):

```sql
ALTER TABLE workspaces ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
-- BEFORE UPDATE trigger: refuses any change of encrypted (raise WORKSPACE_ENCRYPTION_IMMUTABLE).
CREATE FUNCTION workspace_sealed(uuid) RETURNS boolean STABLE LANGUAGE sql AS
  $$ SELECT coalesce((SELECT encrypted FROM workspaces WHERE id = $1), false) $$;

CREATE TABLE workspace_keys (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_key_wraps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('password', 'recovery')),
  user_id text REFERENCES auth_users(id) ON DELETE CASCADE,  -- null exactly for 'recovery'
  key_version integer NOT NULL,
  kdf jsonb NOT NULL,          -- {"alg":"argon2id","v":19,"m":65536,"t":3,"p":4,"salt":"<b64url 16 bytes>"}
  wrapped text NOT NULL,       -- AES-256-GCM envelope of the DEK, see Key wrapping
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'recovery') = (user_id IS NULL))
);
CREATE UNIQUE INDEX workspace_key_wraps_person ON workspace_key_wraps (workspace_id, user_id) WHERE kind = 'password';
CREATE UNIQUE INDEX workspace_key_wraps_recovery ON workspace_key_wraps (workspace_id) WHERE kind = 'recovery';

CREATE TABLE workspace_unlocks (
  workspace_id uuid PRIMARY KEY REFERENCES workspace_keys(workspace_id) ON DELETE CASCADE,
  boot_id uuid NOT NULL,       -- the keyring boot whose key sealed the DEK
  key_version integer NOT NULL,
  sealed_dek text NOT NULL,    -- AES-256-GCM under the boot key, see Unlock
  unlocked_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_unlock_attempts (   -- failed attempts only; rows older than 15 minutes are ignored and pruned
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sealed_job_waits (            -- work that needs the DEK and arrived while locked; ids only
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  queue text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
```

- The F-029 trigger that writes the new workspace's `workspace_ai_policies` row writes `'blocked'`
  when `NEW.encrypted`, and a `BEFORE UPDATE` trigger on `workspace_ai_policies` refuses `'allowed'`
  for a sealed workspace (`WORKSPACE_ENCRYPTED_AI_OFF`). See [AI forced off](#ai-forced-off).
- S2 adds `search_documents.sealed`, `search_changes`, `idempotency_keys.workspace_id`, the
  [plaintext backstop](#enforcement) triggers and the relaxed checks.
- The reverse migration drops the new tables and columns. It refuses to run while a sealed
  workspace exists, because the data cannot be read without the new tables.

## Cryptography

All primitives come from `node:crypto` in the pinned Node image (24.21.0, OpenSSL 3.5.8,
observed 2026-10-23). No new dependency is added. That build offers AES-GCM and ChaCha20-Poly1305
but not XChaCha20-Poly1305 or AES-GCM-SIV (`crypto.getCiphers()`, observed). Flux already uses
AES-256-GCM for the background key (`packages/db/src/background-key-crypto.ts`) and the search
cursor.

### Keys

| Key | Derivation | Use |
| --- | --- | --- |
| DEK | `randomBytes(32)` at creation | Root of the workspace. Never used directly. |
| `K_seal` | HKDF-SHA256(DEK, salt = workspace UUID bytes, info `flux seal v1`) | Database fields. |
| `K_file` | same, info `flux file v1` | File objects. |
| `K_digest` | same, info `flux digest v1` | Keyed digests that replace stored SHA-256 values. |

### Field envelope

`fx1.<key version>.<base64url(nonce 12 ‖ ciphertext ‖ tag 16)>`, AES-256-GCM with `K_seal`.

- **Nonce.** 96 random bits for each seal. NIST SP 800-38D §8.3 limits random 96-bit IVs to 2^32
  encryptions per key. The heaviest writer is the live Wiki: about three seals for each admitted
  update (update bytes, ledger and head body). At five updates a second without pause, one
  workspace needs about 6.8 years of continuous typing to reach the limit. `key_version` exists for
  a later [rotation](#rotation).
- **AAD** binds the value to its place: the UTF-8 of
  `flux:seal:v1|<workspace id>|<field>|<row identity>|<key version>`. `field` is the registry name
  (`project_messages.body`). `row identity` is the row's primary-key values joined by `/`
  (`<material id>/<version>` for a material version). A ciphertext copied to another row, column,
  table or workspace fails authentication. That stops row and column swapping.
- **Values copied in SQL** keep their identity. Where SQL copies a sealed value between tables, both
  columns share one registry field and identity. Today that is the live Wiki head and its archive:
  `doc_live.body` and `doc_live.codec_state`, identity `<doc id>/<generation>`. The registry test
  fails if any other SQL copy of a sealed column appears. Such a copy must be moved to the
  application, which opens and re-seals the value.
- **jsonb columns** store `{"$sealed":"fx1…"}`, so `jsonb_typeof = 'object'` checks still hold. Text
  columns store the envelope string.
- **Lengths are not hidden.** There is no padding. Ciphertext length is plaintext length plus 28
  bytes, then base64.

### Files

Files are limited to 5 MiB (`FILE_LIMITS.fileBytes`), so one GCM pass per file is enough. The
object is `FXF1 ‖ key version (uint32) ‖ nonce 12 ‖ ciphertext ‖ tag 16`, with `K_file` and AAD
`flux:file:v1|<workspace id>|<file id>|<key version>`. The file id is the reservation id
(`files/service.ts` reserves before `storage.receive`), so it is known before the first byte.
`FileStorage.receive` takes an optional `FileCipher`. It encrypts each chunk as it streams into
the scratch file, so plaintext never reaches `attachments/tmp`. `read` returns bytes only after the
tag verifies. `size` stays the plaintext size. `sha256` becomes the [keyed digest](#digests), and
`has` compares that digest over the decrypted bytes. Thumbnails are made only in the browser
(`composer/Attachments.tsx`), so nothing else is stored.

### Digests

A stored unkeyed SHA-256 of content lets an attacker confirm a guess ("does this workspace hold
`leaked.pdf`?", "is this message `ok`?"). In a sealed workspace every **stored** digest of content
is `HMAC-SHA256(K_digest, <domain> ‖ 0x00 ‖ bytes)` in the same 64-hex format, so existing checks
still hold. This covers `request_fingerprint` and `fingerprint` columns, `doc_live_*.hash`,
`project_files.sha256`, `idempotency_keys.request_hash` and the plan-intent `creation_fingerprint`.
One helper, `contentDigest(seal, domain, bytes)` in `packages/core/src/encryption`, replaces
`createHash('sha256')` at each storage site (the files using it today are listed by
`grep -rl "createHash('sha256')" packages/core/src packages/db/src apps/server/src`). Where a wire
protocol compares a SHA-256 that the client computes (the live Wiki head `hash` on Save), the server
computes it from the decrypted body in RAM and never stores it.

### Key wrapping and the KDF

- **KEK** = Argon2id(password as UTF-8 NFC, salt = 16 random bytes, **m = 64 MiB, t = 3, p = 4**,
  32-byte tag). This is the "second recommended option" of
  [RFC 9106 §4](https://www.rfc-editor.org/rfc/rfc9106.html#section-4) (read 2026-10-23), meant for
  when much less memory is available than the 2 GiB of the first option. It uses `crypto.argon2`
  (added in Node v24.7.0 per the [v24 API docs](https://nodejs.org/docs/latest-v24.x/api/crypto.html),
  read 2026-10-23). It runs off the event loop on libuv's thread pool. Observed on this host on
  2026-10-23: 55 ms with p = 4 and 106 ms with p = 1, on 24 cores. A small VPS will be slower.
  The parameters are stored per wrap (`kdf`). A successful unlock with older parameters re-wraps
  under the current ones.
- `wrapped` = AES-256-GCM(KEK, random nonce, DEK), with AAD
  `flux:wrap:v1|<workspace id>|<wrap id>|<kind>|<user id or ->|<key version>`. A wrong password fails
  the tag, so there is no separate verifier.
- **Recovery code.** 160 random bits as 32 Crockford base32 characters, shown in 8 groups of four
  (`K7QD-2M9X-…`). Input is normalised: upper case, spaces and hyphens removed, `O→0`, `I/L→1`.
  It is wrapped the same way, with Argon2id, so there is one code path. The code is never stored.
- **Concurrency.** At most two derivations run at once per API process (64 MiB each). Others queue,
  and the ninth waiting request answers `503 UNLOCK_BUSY`.
- **Passwords** need at least 12 characters, with no composition rules. The UI suggests a password
  not used to sign in.

### Password lifecycle

| Event | Effect |
| --- | --- |
| Creation | The creator (owner) gets a `password` wrap and the workspace a `recovery` wrap. The code is returned once. |
| A person becomes owner or admin | No wrap yet. While the workspace is unlocked, they set their own password (`PUT …/unlock-password` without `currentPassword`). The server wraps the DEK it holds in RAM. |
| Change own password | Needs `currentPassword` (or the recovery code). Re-wraps under a new salt. |
| Demoted to member or guest, removed, or account deleted | The `password` wrap is deleted in the same transaction as the role change. |
| The last person with a password would lose it | Refused with `409 LAST_UNLOCK_PASSWORD`: "Garden club needs at least one unlock password. Ask another owner or admin to set theirs first." The recovery code alone is not counted. |
| New recovery code | Owner only, while unlocked, with their own unlock password. It replaces the `recovery` wrap. The old code stops working. |

Stated limits. Someone who holds an owner's or admin's **session** while the workspace is unlocked
can already read everything. If that account has no password yet, they can also set one. A person
who was removed can still open **backups taken before the removal** with their old password, as can
an old recovery code. Only rotation can close that gap.

### Rotation

Rotation is not required in this version. `key_version` on the keys, wraps, unlock rows and every
envelope leaves room for it. A later rotation would create DEK v2, re-seal every value in batches by
a worker job while unlocked, re-wrap for each holder and then drop v1. Reconsider when a workspace
needs to exclude a former admin from old data, or approaches 2^31 seals.

## Inventory

Each workspace-content table is listed with its columns. **S** means sealed (envelope), **D** means
keyed digest, and **V** means visible metadata. A column not named is an id, foreign key, number,
enum, boolean or timestamp (V). One registry, `SEALED_COLUMNS` in `packages/db/src/sealed-columns.ts`,
holds every S and D entry with its field name and identity columns. `VISIBLE_COLUMNS` holds every
text or jsonb V column of these tables with a one-line reason. The [registry test](#tests-and-acceptance-criteria)
fails on any text or jsonb column in neither list.

| Table | S (sealed) | D (keyed digest) | V (visible text/jsonb, reason) |
| --- | --- | --- | --- |
| `workspaces` | — | — | `name`: shown to members while locked ("Garden club is waiting to be unlocked") |
| `projects` | `name` | — | `visibility`, `views` (enums) |
| `project_goals` | `title` | — | — |
| `project_conversations` | — | — | `space` (enum) |
| `project_messages` (includes task discussion replies) | `body` | `request_fingerprint` | `contribution_kind` (enum) |
| `project_message_observations`, `dm_message_observations`, `return_points` | — | — | ids and positions only |
| `dms` | `title` | — | `kind`, `pair_key` (user ids) |
| `dm_messages` | `body` | `request_fingerprint` | — |
| `project_materials` | — | `request_fingerprint` | `kind` |
| `project_material_versions` (docs and Wiki) | `title`, `body`, `url`, `reason` | `request_fingerprint` | `state` |
| `project_work_items` (tasks) | `title`, `outcome`, `blocker`, `criteria`, `creation_baseline` | `request_fingerprint` | `status`, `owner_user_id`, `waiting_for_user_id`, `due_on`, `number`, `creation_origin` |
| `project_task_activity` | `detail` (old and new values) | — | `kind` (status, owner, due or title changed) |
| `project_task_updates` | `reason` | — | `kind` |
| `project_task_notices` | — | — | `sources` (object refs) |
| `project_task_plan_intents` | — | `creation_fingerprint` | `intent_key` (client-chosen opaque key; the web client sends random UUIDs) |
| `task_creation_undo_receipts`, `native_command_receipts` | — | `request_fingerprint` | operation names |
| `project_decisions` | `title`, `rationale` | — | `status` |
| `project_results` | `title`, `evidence` | — | `finding` (positive or negative) |
| `project_object_links` | — | — | `role`, types |
| `drafts` | `title`, `body` | — | `visibility` |
| `sketches` (maps) | `title` | — | `scope` |
| `sketch_thoughts` | `text` | — | `shape`, `x`, `y`, `width`, `height`, `source_author_name` (a person's name, account data) |
| `sketch_links` | `label` | — | endpoints |
| `project_files` | `name`, file bytes ([Files](#files)) | `sha256` | `size`, `state` |
| `doc_live_heads`, `doc_live_archives` | `body`, `codec_state` (field `doc_live.*`) | `hash` | sequences, generation |
| `doc_live_updates` | `bytes`, `ledger` | `fingerprint` | actor, command id |
| `doc_live_snapshots` | — | `hash` | `contributors` (people ids) |
| `doc_live_presence`, `map_live_presence`, `map_live_gestures` | — | — | `cursor`, `selected`, `positions`: Yjs relative positions or coordinates in leases of 5–30 s, with no text |
| `live_editing_intents` | `receipt` | `fingerprint` | `operation` |
| `map_live_journal` | `change` | `fingerprint` | actor |
| `notifications` | — | — | `title`, `body`: **content-free by construction** ([Notifications](#notifications-push-and-e-mail)); `url` (ids); `summary_sources` (refs) |
| `events` | — | — | `data`: ids, versions and enums only. A test enforces this ([Enforcement](#enforcement)). |
| `idempotency_keys` (rows of a sealed workspace) | `response_body` | `request_hash` | `operation`, key |
| `search_documents` (rows of a sealed workspace) | — (placeholder rows hold no content, [Search](#search)) | — | `kind`, `audience_key`, `status`, author, time |
| pg-boss `job.data` | — | — | ids only (checked for the queues that touch sealed workspaces) |
| `live_sessions`, `live_presentations`, `live_invitations`, `live_admissions` | — | — | room ids, states, references |

**Tables that stay empty for a sealed workspace.** The F-029 lock is forced on, and its
`ai_work_admission` backstop and entry checks refuse every insert. So no rows exist in
`personal_runs`, `assistant_*`, `cowork_*`, `agents`, `agent_*`,
`agent_proposals`, `agent_questions`, `proactive_comparison_*` or `agent_runtime_sessions`. The
dump-scan test proves this per table.

**GitHub is not offered in sealed workspaces in this version.** A webhook can arrive while the
workspace is locked, and `github_deliveries.payload` would then hold repository and PR text in
plaintext with no key to seal it. Binding a project of a sealed workspace answers
`409 WORKSPACE_ENCRYPTED_UNSUPPORTED`. The founder's list of what works ("conversations, tasks,
maps, live Wiki, files and search") does not include it. Reconsider when deliveries can be held
sealed under a per-workspace public key.

### What stays visible metadata

This is stated plainly for the review and for the operations guide. Someone with the disk can see:

- the workspace's name, that it is encrypted, its members and their roles, invitations, who has an
  unlock password, and when and by whom it was unlocked or locked;
- how many projects, conversations, messages, tasks, docs, versions, maps, thoughts, links and
  files exist, with their ids, authors, times, sizes and value lengths;
- the structure: which message is in which conversation and task, reply order, attachment counts,
  DM participants, task dependencies and links between objects;
- **tasks: number, status, owner, waiting-for person and due date**; decisions' status; results'
  positive or negative finding; doc states (draft or published) and contributors;
- maps: thought positions, sizes, shapes and link endpoints (not their text or labels);
- that an activity of a kind happened ("title changed", "due changed"), but not the values;
- notifications: who did what, of which kind, for whom, in which workspace.

Nothing listed is text that a person wrote, a name of a thing, or file bytes.

## Enforcement

- **The seal port.** Core declares `WorkspaceSeal { sealed: boolean; seal(field, identity, value); open(field, identity, envelope); digest(domain, bytes); fileCipher(fileId) }`
  in `packages/core/src/encryption/ports.ts`. One adapter, `sealFor(tx, workspaceId, { write })`
  in `packages/db/src/repositories/workspace-seal.ts`, returns the identity seal for a workspace
  that is not sealed. For a sealed one it reads the unlock row (`FOR SHARE` when `write`) and
  returns a real seal, or throws `WorkspaceLockedError` (`423 WORKSPACE_LOCKED`). **There is no
  plaintext fallback.** A sealed workspace never gets the identity seal, so a lock fails reads and
  writes closed with no per-route check.
- **Repositories** seal on write and open on read through `sealRow(table, values, seal)` and
  `openRow(table, row, seal)`. These read `SEALED_COLUMNS` and compute the identity from the row.
  Raw SQL readers (search, notification facts, export) open the aliased columns they select.
- **SQL never computes over sealed columns.** No `ORDER BY`, `WHERE`, `ILIKE`, `char_length`,
  `ts_headline` or concatenation runs over them for a sealed workspace. Such work moves to the
  application after `openRow`. The known site is the task text filter in
  `packages/db/src/repositories/work-read-keys.ts` (`ILIKE`), which filters opened rows in the
  application for a sealed workspace. A source-scan test lists every SQL fragment that references
  a sealed column outside a plain select, insert or update and fails on any not marked as handled.
- **Checks on sealed columns** (`doc_live_head_body`, the message body check from 0045, `jsonb_typeof`
  array checks and others) become `flux_is_sealed(col) OR (<old check>)`. `flux_is_sealed` is an
  `IMMUTABLE` SQL function that accepts only an envelope string or `{"$sealed": <envelope>}`. The
  application still enforces the original limits before sealing.
- **Plaintext backstop.** A generated `BEFORE INSERT OR UPDATE` trigger on each table in
  `SEALED_COLUMNS` resolves the row's workspace (directly, or through `doc_id`/`sketch_id`) and,
  when `workspace_sealed`, raises `WORKSPACE_PLAINTEXT_REFUSED` unless every sealed column is
  `flux_is_sealed`. The raise names the column, never the value. The heap tuple is never written,
  and PostgreSQL does not log bind parameters on error by default (`log_parameter_max_length_on_error = 0`).
  The application never relies on the backstop. It makes a forgotten seal fail loudly instead of
  leaking.
- **Event data.** `recordEvent` in a sealed workspace rejects (in development and tests) any string
  value in `data` that is not a UUID, a registered enum or a principal key. A write that needs
  content in an event seals it in a nested `{"$sealed": …}` field. None does at `3bbae96a`: the
  record sites pass ids, for example `{ conversationId, messageId }` in `conversation/store.ts`.
- **Cross-workspace reads** skip locked workspaces instead of failing. They are the shell loader's
  project list, Home tasks, Inbox and Needs you, search and ⌘K, and the morning summary. Each answers
  with the unlocked items and `lockedWorkspaces: [{ id, name }]`, so the interface draws one "Waiting
  to be unlocked" row per locked workspace.
- **Logs.** The Fastify logger (`logger: true` in `apps/server/src/app.ts`) logs `req.url`. A request
  serializer drops the query string, so `GET /api/v1/search?q=…` cannot write a query to the Docker
  log on disk. Request bodies are never logged, and the unlock routes mark `password`,
  `newPassword`, `currentPassword` and `recoveryCode` as redacted paths.

## Unlock lifecycle across processes

### Options considered

The key entered in one API process must reach every API replica and the worker without touching a
disk, and PostgreSQL must never see it.

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **A. Keyring process holding one boot key; DEKs sealed under it in PostgreSQL** | The only RAM-only secret is one key in one tiny process. Lock state is a row, so every process sees it transactionally, ordered by row locks like the F-029 policy. A keyring restart makes every unlock row unopenable, which locks all at once. Works across hosts. | One new small service and network. | **Chosen** |
| B. Keyring holding the DEKs themselves | Same RAM property. | Two sources of truth: a keyring restart leaves "unlocked" rows in PostgreSQL that point at nothing, and every lock-state read becomes a network call. | Rejected |
| C. Redis with persistence disabled | Off-the-shelf. | Flux has no Redis (O-002 is PostgreSQL only). Redis turns RDB snapshots on by default, and one wrong setting puts the keys on disk with no error. It is a heavier service than A for the same job. | Rejected |
| D. A shared `tmpfs` volume holding the boot key | No new process. | Single host only. A Docker volume left without its tmpfs options silently becomes a disk volume. Whether it survives `compose restart` depends on reference counting. | Rejected |
| E. Broadcasting the DEK through PostgreSQL (`NOTIFY`, a table) | No new process. | PostgreSQL would see the key, which is forbidden. | Rejected |

### The keyring (`apps/keyring`)

- **Process.** A new app, `@flux/keyring`: Node built-ins only, about 100 lines, in the same image
  with its own command. At start it creates `bootKey = randomBytes(32)` and `bootId = randomUUID()`.
  It writes nothing, has no volume and keeps no state beyond these two.
- **Requests.** Plain HTTP on `keyring:8090` on a dedicated Compose network `keyring`
  (`internal: true`), joined only by `api`, `worker` and `keyring`. Runtime slots, LiveKit, mocks and
  the database are not on it. Every request carries `Authorization: Bearer <FLUX_KEYRING_TOKEN>`,
  which `./flux` generates into `docker/.env` like the other secrets. A stolen token is useless
  without the running keyring.
  - `GET /v1/boot` → `{ bootId }` (no secret; the heartbeat).
  - `POST /v1/seal { workspaceId, keyVersion, dek }` → `{ bootId, sealed }`: AES-256-GCM under the
    boot key, AAD `flux:unlock:v1|<workspace id>|<boot id>|<key version>`.
  - `POST /v1/open { workspaceId, keyVersion, bootId, sealed }` → `{ dek }`, or `409 STALE_BOOT` when
    `bootId` is not its own.
  - Nothing else. Bodies are never logged.
- **Single instance.** Exactly one keyring per deployment. Two would have two boot keys. API
  replicas scale freely.
- **Hardening.** `read_only: true`, `cap_drop: [ALL]`, `ulimits: { core: 0 }`, `mem_limit: 64m` and
  `memswap_limit: 64m`. With `--memory-swap` equal to `--memory` the container
  "doesn't have access to swap" ([Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/),
  read 2026-10-23; this needs kernel swap-limit support, and `docker info` warns when it is missing).

### Unlock

1. An owner or admin sends `POST /api/v1/workspaces/:id/unlock { password }` (or `{ recoveryCode }`).
2. The API checks `workspace.manage_encryption` (owner or admin, humans only) and the attempt limit:
   five failures per person and workspace in 15 minutes, and twenty per workspace, give
   `429 UNLOCK_RATE_LIMITED` with `Retry-After`.
3. It derives the KEK (Argon2id) and opens that person's wrap, or the recovery wrap. A tag failure
   records an attempt row and answers `400 UNLOCK_INCORRECT`.
4. It calls the keyring's `seal`. In one transaction it upserts `workspace_unlocks` (replacing a
   stale row from another boot), records `workspace.unlocked.v1` (`{ by: <user id> }`) and sends the
   `workspace-encryption.resume.v1` job. It then zeroes the DEK and KEK buffers it no longer needs.
5. Already unlocked under the current boot gives `200` with no change. The password is then not
   checked, so a repeat gives no oracle.

### Every content operation

`sealFor` reads the unlock row in the operation's own transaction. If the row's `boot_id` equals the
process's last known boot id, the process uses its cached DEK for `(workspace, boot_id, unlocked_at)`
or calls `open` once on a miss. If they differ, the process asks `GET /v1/boot`. A different boot
means the row is stale, so the workspace is treated as locked and the stale row is deleted.

- **Writes** read the row `FOR SHARE` first, before the F-029 policy row and every other lock, so a
  Lock is ordered strictly before or after each write.
- Reads take no lock. A read that started before a Lock may finish, but nothing is written afterwards.

### Lock and restart

- **Lock now.** `POST /api/v1/workspaces/:id/lock` (owner or admin) deletes the row `FOR UPDATE`,
  then takes only the person's membership `FOR SHARE`, and records `workspace.locked.v1`
  (`{ reason: 'person' }`). Role changes never read the unlock row, so there is no lock cycle.
- **Restart.**

  | What restarts | Result |
  | --- | --- |
  | The keyring, the whole stack (`docker compose restart` or `down` then `./flux up`, `./flux upgrade`, which recreates every container) or the host | Every sealed workspace is **locked**. The boot key is gone, so every unlock row is stale. |
  | Only an API replica or the worker, including the stop and start around `./flux backup` | Still unlocked. The process asks the keyring again. |

- **Heartbeat.** Every API and worker process polls `GET /v1/boot` every 5 s. When the boot id
  changes, the process drops its DEK cache, live rooms and search indexes. It deletes the stale rows
  and records one `workspace.locked.v1` (`{ reason: 'restart' }`) for each; concurrent deleters do no
  harm. An unreachable keyring leaves cached keys in use: availability, not secrecy, is at stake,
  and the threat model excludes a running server. A process that starts while the keyring is
  unreachable treats every sealed workspace as locked, and unlock answers `503 KEYRING_UNAVAILABLE`.
- **On lock** (either reason) each API process closes that workspace's live rooms with close code
  `workspace_locked`, drops its in-RAM search index and zeroes its DEK and subkey buffers.

### Memory: what is done and what is not

- Core dumps are off (`ulimits: core: 0`) for `api`, `worker` and `keyring`.
- Swap is disabled for the keyring through `memswap_limit`. API and worker processes hold DEKs and
  plaintext while unlocked. The [operations guide](../operations/install-release.md) will tell
  operators to run without swap or with encrypted swap and never to hibernate the host. `./flux up`
  prints a warning when swap is active on the host (`/proc/swaps`) and a sealed workspace exists. Flux does not set
  memory limits on the API or worker, because a wrong default would kill them.
- Node has no `mlock`. Key buffers are zeroed with `fill(0)` when dropped. JavaScript strings holding
  plaintext cannot be zeroed and stay in the heap until garbage collection. That is accepted, because
  RAM is outside the threat model.
- PostgreSQL never receives a DEK, KEK, boot key, password or recovery code, in a statement, a
  parameter or a row. The unlock and password routes do not use the Idempotency-Key store,
  because its `request_hash` would be a fast hash of a password.

## Locked behaviour

**Fail closed everywhere. Nothing falls back to plaintext.**

| Surface | While locked |
| --- | --- |
| Any route that reads or writes a sealed column of that workspace | `423 WORKSPACE_LOCKED` `{ code, message: "Garden club is waiting to be unlocked.", details: { workspaceId } }`. No partial body. |
| Workspace list and read, members, roles, invitations, People, leave, the encryption status, unlock | Work (metadata). `encryption.state = 'locked'`. |
| Cross-workspace lists (Home, Inbox, ⌘K, search, the morning summary) | Omit the workspace's items and return it in `lockedWorkspaces`. |
| The event stream | Delivers id-only events as today. Fetching the object answers 423. |
| Live Wiki and maps | No room opens (WebSocket refusal `workspace_locked`). Open rooms close on lock. Unsaved typing stays in the browser's visit copy (#651) and is offered again after unlock. |
| Files | Upload and download answer 423. |
| Notification generation (worker) | An event of a locked sealed workspace is recorded in `sealed_job_waits` (`notifications.generate`, `{ eventId }`) and the cursor moves on, so other workspaces never wait. |
| `draft.summarize.v1` | The handler records a wait and completes the job. |
| Push and e-mail sends | Go out. Their text is content-free and never needs the key. |
| `idempotency.cleanup.v1`, `workspace-ai.sweep.v1` | Run. They read no sealed column. |
| AI jobs | Never exist (F-029). |
| **After unlock** | `workspace-encryption.resume.v1` replays that workspace's waits in creation order and deletes each once handled. Notifications are unique per `(user_id, event_id)`, so a replay never duplicates. |

The API test enumerates every registered route (Fastify `onRoute`), resolves its parameters to
objects of a locked sealed workspace, and expects either `423` or membership in `LOCKED_ALLOWED_ROUTES`
(`packages/contracts/src/encryption.ts`), the metadata routes above, each with a reason. A new
route must be classified.

## Behaviour while unlocked

Everything except AI works as in any workspace: conversations, DMs, tasks and task discussions,
decisions, results, goals, drafts, maps, the live Wiki, files, search, live sessions and export.

### Search

Today's search runs entirely in PostgreSQL: SQL triggers write plaintext `title` and `body` into
`search_documents`, and `tsv`/`keys` are generated from them ([search](../development/search.md)).
PostgreSQL cannot index ciphertext. A blind index of keyed tokens in the same GIN index was
considered and rejected: its deterministic tokens reveal term frequency and co-occurrence to anyone
with the dump, and the one-character prefix keys are nearly as guessable as letters. The choice is
an **encrypted index at rest, decrypted into RAM**:

- **At rest.** `search_documents.sealed boolean`. For a sealed workspace the existing triggers branch
  on `workspace_sealed(NEW.workspace_id)` and write a **placeholder row**: kind, `audience_key`,
  project, object, version, status, author and time, with `title = ''` and `body = ''`. The generated
  `tsv` and `keys` are empty when `sealed`. Each trigger also appends `(workspace_id, doc_key)` to
  `search_changes (seq bigserial)` on insert, update and delete. The content stays only in the
  source tables, sealed. Person rows (account names) keep the SQL path.
- **In RAM.** Each API process keeps a `SealedSearchIndex` per unlocked workspace
  (`apps/server/src/search/sealed-index.ts`), partitioned by `audience_key`. It is built on the first
  search after unlock, or eagerly by the process that unlocked. It reads the placeholder rows and
  each kind's content through a `sealedContent` loader added to `SEARCH_SOURCES`
  (`packages/core/src/search/sources.ts`), which opens the source columns and composes title and body
  as the triggers do today (a task's body is `#number`, outcome and blocker). Before every search the
  process applies `search_changes` after its watermark (one indexed query), so a committed edit is
  searchable at once on every replica. Changes older than 24 hours are pruned by the hourly cleanup
  job, and an index older than the oldest kept change is rebuilt. The index is never written to disk
  and is dropped on lock.
- **Query.** It accepts the same grammar and the same refusals (`QUERY_NEEDS_WORD`,
  `QUERY_UNSUPPORTED`), `simple`-style lowercasing without stemming, a prefix match on the last word,
  title trigram similarity with pg_trgm's default threshold of 0.3, and websearch quotes, `or` and
  `-word`.
- **Access before ranking.** The visible audience keys come from `policySearchAccess` on every request,
  as today. The in-RAM lookup reads only the partitions of those keys, so hidden rows never become
  candidates. The `EXPLAIN (BUFFERS)` saturation property applies to the SQL part. For the in-RAM part
  the test asserts that the work counter (postings read) does not change with hidden matches.
- **Merge.** Plain and sealed results are merged by `(score, at, doc_key)`. The in-RAM score
  approximates `ts_rank` (title weight 1.0, body 0.4) plus title similarity, so ordering between the
  two sources is approximate. The sealed cursor carries the last merged key, and both sources resume
  after it. Counts add up, and each is capped at 500.
- **Bound.** `FLUX_SEALED_SEARCH_MAX_BYTES`, by default 256 MiB of decrypted text per workspace per
  process. A larger workspace answers with `sealedUnavailable: [workspaceId]`, and the page says
  "Search isn't available in Garden club: it is too large to search in memory."

### Live Wiki and maps

Rooms run in the API as today (`apps/server/src/editing`). Every persisted update, ledger, head,
archive, snapshot state, receipt and map journal change is sealed by the controller's repository
call (`packages/db/src/repositories/doc-live.ts`, `live-editing.ts`, `live-map.ts`) inside the same
transaction, which reads the unlock row `FOR SHARE`. The two-API arrangement
([live-editing-two-api](../development/live-editing-two-api.md)) works because each API gets the DEK
through the keyring. The `synchronous_commit = off` transient writes carry no sealed values except
presence, which stays visible.

### Files

Upload and download use the [file format](#files) above. Export bundles decrypt in the API while
streaming. The size and digest checks run on plaintext.

### Notifications, push and e-mail

In a sealed workspace the generator (`packages/core/src/notifications/generate.ts`) opens the message,
task or decision only in RAM, to decide the reason (a mention or question in the body, an assignment).
It then writes a **content-free** row: `title` is "who and why", `body = ''`, and `url` holds ids. The
Inbox, push (`packages/core/src/push/delivery.ts`) and e-mail (`notifications/email.ts`) therefore never
carry content.

| Reason | Title in a sealed workspace |
| --- | --- |
| `mention` | "Ada mentioned you in Garden club" |
| `question` | "Ada asked you in Garden club" |
| `reply` | "Ada replied in Garden club" |
| `dm` | "Ada sent you a message in Garden club" |
| `assigned` | "Ada assigned you a task in Garden club" |
| `review` | "Ada asked for your review in Garden club" |
| `invitation` | "Ada invited you to work together in Garden club" |

The workspace name is visible metadata, and the project name is not used. Opening the item rechecks
access and, while locked, shows the locked state.

### Exports and backups

- **API export** (`GET /api/v1/projects/:id/export`) works while unlocked and streams the plaintext
  bundle to the person who asked (with `project.manage`). That is a deliberate copy leaving Flux. The
  API never writes it to disk.
- **`./flux export`** writes the bundle into `exports/` on the server, which would put plaintext on
  disk. For a sealed workspace it refuses: "Garden club is encrypted. Export it from the app." The
  command exits non-zero.
- **`./flux backup`** copies the database and the files volume as they are, so sealed content stays
  sealed, together with the wraps and `flux.env`. That file holds `FLUX_KEYRING_TOKEN`, which opens
  nothing without the running keyring.
- **`./flux restore`** truncates `workspace_unlocks`, so a restored sealed workspace is **locked**. It
  opens with any owner's or admin's unlock password **as it was when the backup was taken**, or the
  recovery code valid then. The [backup guide](../operations/backup-restore.md) says so. A backup
  without its passwords and code cannot be read by anyone.

## AI forced off

- At creation the policy row is `blocked` (trigger above) and stays so. `PUT /api/v1/workspaces/:id/ai-policy`
  answers `409 WORKSPACE_ENCRYPTED_AI_OFF` before any other check that could pass. The database
  trigger refuses `allowed` as a backstop. Every F-029 enforcement point then applies unchanged:
  no agent, assistant, MCP client, run, schedule, reaction, comparison or event audience for an agent.
- `Workspace.ai` gains `fixed: 'encrypted' | null`. While it is `'encrypted'`, the client shows no
  switch.
- The People panel's AI row (`WorkspacePeople.tsx`, the section **AI in Garden club**) keeps its place
  and shows, to everyone including members: "Off · Garden club is encrypted, so AI can never be turned
  on here." There is no button.
- `<AiSurface>` already renders nothing while blocked, so the human-only interface comes for free.

## UI contract

The [final design](../design/final/README.md) and [Spokój](../design/spokoj/README.md) apply:
calm text, few buttons, controls that never move. "Space" is the interface's word for a workspace.

### Creating an encrypted space

Today the only workspace creation in the interface is the first space in project setup
(`app/newProject.ts`, `ProjectSetup.tsx`). S3 adds **New space** as the last row of Home → Details
→ People (`app/Details.tsx`, `PeopleEntries`). It opens a small form in the Details panel (the
Details sheet on a phone):

- **Name** (as today).
- A checkbox row, **Encrypt this space**, with the line: "Everything inside is encrypted on the
  server. Only people work here: no agents, no assistant, no AI. This can't be changed later."
- When checked, these appear in place below it: **Unlock password** (hint: "At least 12 characters.
  Each owner and admin has their own. It's needed after every server restart. Use one you don't use
  to sign in.") and **Repeat password**. Then one line: "If every unlock password and the recovery
  code are lost, everything in this space is gone for good. Nobody can recover it, not even whoever
  runs this server."
- The button reads **Create space**, or **Create encrypted space** when the box is checked.

The next step, in the same panel, is **Your recovery code**. The code is shown in monospace groups
with the text "This code unlocks Garden club if every password is lost. It's shown only now. Print
it or write it down and keep it somewhere safe." Buttons **Print** and **Copy** sit above a checkbox
"I've kept the recovery code", and **Done** is enabled only after it is checked. Nothing about the
code is stored in the browser. If the answer to the create call was lost, a retry with the same
`creationId` returns the space without the code. The panel then says "The recovery code was shown
once and can't be shown again. Make a new one in People." and offers **New recovery code**.

Project setup's first space keeps its form and is never encrypted. The new space appears in the
project picker and in Create like any other space.

### Locked

- **Sidebar and Home.** In place of the workspace's projects there is one row: the lock glyph,
  "Garden club", and on the second line "Waiting to be unlocked". It opens the locked panel.
- **The locked panel**, also used for every deep link into the workspace while it is locked (the URL
  is kept, Back works):
  - For a member or guest: **Garden club is waiting to be unlocked** · "Its content is encrypted.
    After the server restarted, an owner or admin needs to unlock it. You can come back then."
  - For an owner or admin: **Unlock Garden club** · field **Your unlock password** · button **Unlock**
    · quiet link **Use the recovery code**, which swaps the field in place. Errors are shown in place:
    "That password doesn't unlock Garden club." and "Too many tries. Try again in 15 minutes."
  - For an owner or admin without a password: "You don't have an unlock password for Garden club
    yet. Another owner or admin can unlock it, or you can use the recovery code."
- An open page in that workspace turns into the locked panel on `workspace.locked.v1` or on any
  `423`, and back on `workspace.unlocked.v1`, without a reload.

### Inside an encrypted space

- **The People panel** gets an **Encryption** section, its own `details__sec` placed before the AI
  section and kept in place in every state:
  - "Encrypted · only people, no AI. Unlocked by Ada at 09:12."
  - For owners and admins: **Change your unlock password** (or **Set your unlock password** when they
    have none) and a quiet **Lock now**. Lock now uses the panel's inline confirm: "Everyone in Garden
    club loses access until an owner or admin unlocks it again." with **Lock Garden club** and
    **Keep it unlocked**. Owners also get **New recovery code**, behind the same inline confirm and
    their password: "The old code stops working."
  - Members and guests see only the first line.
- **The project's Details**, audience section: one line, "Encrypted space · only people work here,
  no AI."

## API

`packages/contracts/src/encryption.ts`. Every command needs a live session, passes the origin check,
answers `Cache-Control: no-store`, and does not use the Idempotency-Key store.

| Route | Body | Answers |
| --- | --- | --- |
| `POST /api/v1/encrypted-workspaces` | `{ name, creationId, password }` | `201 { workspace, recoveryCode }`. The same person and `creationId` again gives `200 { workspace, recoveryCode: null }`. `400 PASSWORD_TOO_SHORT`, `503 KEYRING_UNAVAILABLE`. In S1 and S2 the route exists only with `FLUX_FIXTURE_TOKEN` set. |
| `POST /api/v1/workspaces/:id/unlock` | `{ password }` or `{ recoveryCode }` | `200 { encryption }`, `400 UNLOCK_INCORRECT`, `403 WORKSPACE_ENCRYPTION_ADMIN_REQUIRED`, `409 NO_UNLOCK_PASSWORD`, `429 UNLOCK_RATE_LIMITED`, `503 KEYRING_UNAVAILABLE` or `UNLOCK_BUSY`. |
| `POST /api/v1/workspaces/:id/lock` | — | `200 { encryption }`, `403`. |
| `PUT /api/v1/workspaces/:id/unlock-password` | `{ currentPassword?, newPassword }` | `200`, `400 UNLOCK_INCORRECT`, `400 PASSWORD_TOO_SHORT`, `423`. |
| `POST /api/v1/workspaces/:id/recovery-code` | `{ password }` | `200 { recoveryCode }` (owner only), `423`. |
| `GET /api/v1/workspaces[/:id]` | — | `Workspace.encryption`: `null`, or `{ state: 'locked' \| 'unlocked', unlockedAt, unlockedBy: { id, name } \| null, myPassword: boolean, canUnlock: boolean }`. `myPassword` and `canUnlock` are filled for owners and admins; others get `false`. |

The new action `workspace.manage_encryption` in `WORKSPACE_ACTIONS` is allowed for a human owner or
admin (`isManager`). `New recovery code` additionally needs the owner role. Events
`workspace.unlocked.v1`, `workspace.locked.v1` and `workspace.unlock_password_set.v1` carry ids only.
Their audience is the workspace's people, and agents are excluded explicitly as for F-029.

## Tests and acceptance criteria

All tests run in Docker. Ports and Compose project names follow [containers](../development/containers.md).
The fixture has an owner Ada, an admin Ben, a member Cy and a guest Dee in sealed workspace A, and
the same people in plain workspace B as the control. In S1 and S2, A is created through the fixture
route.

| AC | Slice | Test | Where |
| --- | --- | --- | --- |
| AC-1 | S1 | Crypto: envelope round trip. A ciphertext moved to another row, column, table or workspace fails, as do a tampered tag, a wrong key version and a wrong DEK. Wraps use the stored KDF parameters, and a wrong password fails the tag. Recovery code normalisation. Keyed digest differs from SHA-256 and between workspaces. File object round trip, truncation and tampering refused before any byte is returned. | `tests/app/encryption-crypto.test.ts` |
| AC-2 | S1 | Lifecycle: create, unlock with the right password (`200`), the wrong one (`400`), the sixth failure (`429`), the recovery code. A non-holder admin gets `409`. A member, a guest and an agent get `403`. Set and change password, new recovery code (the old one stops working), demotion deletes the wrap, `409 LAST_UNLOCK_PASSWORD`, Lock now gives `423` on the next content call. The idempotent create retry has no code. | `tests/app/encrypted-workspaces.test.ts` |
| AC-2 | S1 | AI forced off: the policy is `blocked` at creation; `PUT ai-policy` gives `409`; a direct SQL update to `allowed` is refused by the trigger. The F-029 gated-route list gives `403 WORKSPACE_AI_BLOCKED` in A and works in B. | same, with `workspace-ai-routes.test.ts` cases |
| AC-3 | S1 | **Restart is locked.** Unlock A and write. `docker compose restart` of the whole stack makes A's content routes answer `423` and `encryption.state = 'locked'`, and unlock works again. Restarting only `api` keeps A unlocked. Restarting only `keyring` locks A within 5 s, with one `workspace.locked.v1 { reason: 'restart' }`. | `app/tests/app/encryption-restart.check.ts`, called by `check_application.sh` |
| AC-4 | S1 | **Multiple processes.** Two API containers, the worker and the keyring (pattern of the [two-API fixture](../development/live-editing-two-api.md)). Unlock on API-1, then read on API-2 at once. Lock on API-2, then API-1's next write gives `423`. No process ever sends the DEK to PostgreSQL (`pg_stat_activity` and the statement log sampled during unlock). | `tests/app/live/encryption-two-api.test.ts`, `docker/compose.encryption.test.yaml` |
| AC-5 | S2 | Registry: every text or jsonb column of the content tables is in `SEALED_COLUMNS` or `VISIBLE_COLUMNS`. Each sealed table has its backstop trigger. An insert of plaintext into each sealed column of A is refused, while B is unchanged. The SQL source scan finds no unhandled computation over a sealed column. Event data in A carries only ids and enums. | `tests/app/encryption-registry.test.ts` |
| AC-6 | S2 | Locked routes: every registered route gives `423` for A's objects or is in `LOCKED_ALLOWED_ROUTES`, with no `500` and no content. Cross-workspace lists return B's items plus `lockedWorkspaces: [A]`. | `tests/app/encryption-locked-routes.test.ts` |
| AC-7 | S2 | **A stolen dump contains no plaintext.** The test puts random canaries in every content type of A through the real API and live sockets: project name, message, task discussion reply, DM and group title, task title, outcome, blocker and criteria, a task title change, decision, result, goal, draft, map title, thought text and link label (live map), Wiki text typed live and saved, material URL, file name and file bytes, a mention notification, a search for a canary, the unlock passwords and the recovery code. It then **stops the whole stack** and scans `pg_dump` output (the pg-boss schema included), the raw PostgreSQL volume including `pg_wal`, the files volume and every container's log. Each canary is searched raw, in JSON-escaped form, in hex and in base64 (standard and URL alphabets, at all three offsets; Yjs update bytes are stored as base64 text). **Positive control:** the same canaries in B must be found. A must give zero hits, and every AI table must have zero rows for A. | `app/tests/app/encryption-dump-scan.check.ts`, `scripts/check_encryption_scan.sh` |
| AC-8 | S2 | Features in A match B: messages, DMs, tasks and filters, decisions, results, docs and versions, drafts, maps, live Wiki and maps across two APIs, files (upload, download, tampered object refused), export bundle content and digests, and notifications content-free on push (mock) and e-mail (Mailpit). Search covers every kind, labels, typo tolerance, prefix, web syntax, access before ranking (no candidates from hidden audiences; a work counter that does not grow with hidden matches), an edit searchable at once on the other API, merged paging with B, and rebuild after lock and unlock. | `tests/app/encryption-features.test.ts`, `encryption-search.test.ts` |
| AC-9 | S2 | Locked jobs wait: a message posted, then Lock before the generator runs, gives no notification; after unlock, exactly one. A draft summary is deferred and resumed. Push and e-mail of earlier rows still go out with no content. | `tests/app/encryption-worker.test.ts` |
| AC-10 | S2 | Backup and restore: the backup holds no canary (the AC-7 scanner on the archive). After restore A is locked and opens with the password valid at backup time; a password set after the backup does not open it. `./flux export` of A exits non-zero with the message. | `scripts/check_backup.sh` case |
| AC-11 | S3 | Chromium and WebKit, on desktop and phone viewports: create an encrypted space (the copy is present; the button label changes; the repeat mismatch shows an error in place), the recovery code step (Done is disabled until the box is checked; nothing in `localStorage` or `sessionStorage`), the People panel encryption and AI rows in fixed places, the project's Details line, zero `[data-ai-surface]` in A. Restart the stack: Cy sees "Waiting to be unlocked" in the sidebar and at a deep link; Ada gets the wrong-password message, then unlocks, and Cy's open tab updates without a reload. Ben sets his password. Lock now with the inline confirm, and focus returns. Keyboard only. Then a visual review under a neutral brief. | `tests/ui/test_encrypted_workspaces.py` (`./scripts/check_ui.sh`) |
| AC-12 | each | Final candidate evaluated independently under the [bounded review policy](../agents/evaluation.md). | PR review |

## Delivery slices

One issue, #655, and one owner. Each slice is its own PR with its own review, and each can be merged
alone. **Nothing lets a sealed workspace be created in production until S3.** In S1 and S2 the create
route exists only with `FLUX_FIXTURE_TOKEN` set, like the other fixture routes, so a real deployment
never holds a half-sealed workspace.

- **S1: keys, the keyring and the lock lifecycle.** Migration 0118. `packages/core/src/encryption`
  (envelope, AAD, HKDF, Argon2id wraps, recovery code, digest), `apps/keyring` with its Compose
  service, network, token and hardening, and the [architecture](../development/architecture.md) table
  row for `@flux/keyring`. Also the unlock, lock, password and recovery routes; `sealFor` with the
  heartbeat and cache; AI forced off; the `encryption` wire field; and AC-1 to AC-4. No content is
  sealed yet, and that is safe because production cannot create a sealed workspace.
- **S2: sealed content.** `SEALED_COLUMNS` and `VISIBLE_COLUMNS`, the backstop triggers and relaxed
  checks, sealing in every listed repository, digests, file encryption, idempotency rows, content-free
  notifications, `sealed_job_waits` and the resume job, search placeholders with `search_changes` and
  the in-RAM index, live Wiki and maps, log redaction, `./flux export` refusal and restore truncation,
  and AC-5 to AC-10. It may land as two PRs (S2a database and files; S2b live editing and search),
  each still fixture-only. **S3 may not merge until AC-7 passes on S2's final head.**
- **S3: creation and interface.** The production route; New space with encryption and the recovery
  code step; the locked panel and sidebar row; the People panel sections; the project Details line;
  `lockedWorkspaces` drawn on Home, Inbox and ⌘K; and the operations guides (install, backup and
  restore, upgrade: "upgrading locks encrypted spaces; have an unlock password ready"). Then AC-11
  and the visual review.

## Founder answers (2026-10-23)

Recorded on #655 by Hubert in the supervising session. These are founder direction, not proposals:

1. **Encryption model.** Server-side per-workspace encryption, not E2EE. Each encrypted workspace has
   its own key for its content in the database, the files and the search index. Nothing is written
   to disk in plaintext.
2. **Key location.** The key never lies on disk unwrapped. After a start or restart, encrypted
   workspaces are locked until an owner or admin enters their unlock password. The key is then held
   only in RAM. A server taken away powered off cannot decrypt anything. Members of a locked
   workspace see "Waiting to be unlocked".
3. **Passwords.** Every owner and admin sets their own unlock password, and the key is wrapped for
   each of them. A one-time recovery code is shown at creation for printing. If every password and
   the code are lost, the data is gone, and the UI says so.
4. **What works while unlocked.** Everything except AI: conversations, tasks, maps, the live Wiki,
   files and search (with an encrypted index). Push and e-mail carry only "who and why", never
   content.

The founder also fixed that encryption is optional, chosen at creation and irreversible, and that an
encrypted workspace is always without AI.

## Not in scope

- E2EE or client-side keys ([#615](https://github.com/ColdPhase/flux/issues/615), set aside).
- Encrypting an existing workspace, or turning encryption off. Encryption is chosen only at creation.
  Moving content into a new encrypted space is a later import feature.
- Key rotation ([Rotation](#rotation)), hardware security modules, and a highly available keyring.
- GitHub bindings and `./flux export` for encrypted spaces.
- Protecting a running server's memory beyond the measures listed.
