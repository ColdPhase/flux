# Live-editing application transport checkpoint — #228

Prepared 2026-10-04 in `codex-hubert/228-live-map-wiki` after the corrected codec
checkpoint `7c5e447f80f65ca247f032f9356b3e36c3e3fba9`. Runtime is **unverified**.
The [accepted live outcome and four gates](live-editing-proposal.md) remain required.
The gate is not yet connected to the application editing use cases or enabled by
default; transport proof does not complete the live feature.

`apps/server/src/http/upgrades.ts` owns the application's single upgrade listener.
It selects media, then editing when composed, then the existing Fastify emitter.
The current index composes the existing media gate with that dispatcher; the editing
controller/SQL adapter is the next composition step. The independently reviewed
peer #170 typing route uses the existing emitter and retains its 1,024-byte receiver.
No peer branch was edited or assumed merged.

The root's first build of `3334ed1f` failed type checking because the older pinned
`@types/ws` omits the public ws 8.22 fragment options; none of the six runtime cases
ran. The narrow source correction declares the exact numeric `maxFragments`,
`maxBufferedChunks` and `closeTimeout` options documented by the pinned public API.
It retains checking of every other server option; its build/runtime are unverified.

`apps/server/src/editing/gate.ts` uses the supported detached `ws` server with its
own 65,536-byte message limit and compression disabled. Pinned primary sources read
2026-10-04: [ws 8.22 API](https://github.com/websockets/ws/blob/8.22.0/doc/ws.md),
[Fastify WebSocket 11.3.1 source](https://github.com/fastify/fastify-websocket/blob/v11.3.1/index.js).
The former documents sharing one HTTP server with detached servers and independent
limits; the latter constructs one server from global options and explicitly directs
detached users to `ws`. These are source/documentation observations, not runtime PASS.

Candidate caps recorded before execution: 32 open plus pending editing admissions,
5-second handshake admission deadline, 144 fragments/buffered chunks, no compression,
1-second close timeout, and at most 65,550 initial head bytes before admission.
Pending authority work keeps its permit until it settles even if the network socket
has gone away; actual authority adapters must retain their finite database deadlines.
Origin and closed kind/resource query validation precede authority work. Identity and
connection ID come from the server. Listeners install synchronously before resuming
the socket. Subsequent protected delivery still requires the accepted SQL fence.

The six finite cases use actual Fastify, its existing WebSocket plugin, the editing
gate and application dispatcher. Media-enabled dispatch includes the current production
media token signer/verifier/proxy with a bounded synthetic signaling upstream;
it establishes neither SFU quality nor SQL authorization. Controlled authority ports
test refusal and pending admission bounds, not the eventual real policy/session fence.
The cases retain stream/typing 1,024-byte refusal, editing 65,536-byte acceptance and
65,537-byte refusal, an immediate masked frame in the upgrade head, closed query/Origin/
anonymous/invisible refusals, expiry during admission, and late resolution after shutdown.

After an explicit serial grant, the source root runs:

```sh
FLUX_LIVE_TRANSPORT_GRANTED=228 FLUX_LIVE_TRANSPORT_HEAD=<frozen-full-SHA> ./scripts/check_live_editing_transport.sh
```

The runner refuses a different or dirty source head before Docker and checks again
after execution. The source owner hands this finite slice to the root for a selective
commit and remains responsible for subsequent SQL/UI implementation. Run from that
clean checkpoint or a root-created frozen review checkout; ongoing SQL edits cannot
silently enter the tested build context. No Docker slot is implied by the checkpoint.

The unchanged pinned application Dockerfile builds/type-checks/lints within a hard
300 seconds; the offline test has a 20-second Node / 30-second outer deadline,
512 MiB RAM/swap, two CPUs, 64 PIDs, read-only filesystem and bounded 32 MiB temporary
cache. It starts no database or published host port. Retain hashes, build output,
image ID and complete TAP under `/tmp/flux-228-transport`; cleanup touches only its
own container/tag. Full default application composition, real SQL authority and two
API processes, shared editor/live reader/map, and the unchanged measured p95 ≤200 ms
still require their separate evidence and independent assessment before enablement.
