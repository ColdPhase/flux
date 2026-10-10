# Exact production codec corpus — prepared Gate2 fixture

This is a separately maintained candidate, not an edit of the frozen #231
calibration or its historical evidence. The original31 tests and five supports
remain under `../live-editing-calibration/`; original independent probes are
bound by hash in `candidate-inputs.json`. This candidate keeps all31 author
controls, all10 inherited independent controls and the retained-backing control.
The inherited probe's ownership adaptation is authored for #228 and requires fresh
independent evaluation; it does not become independent evidence by retaining its
old filename or authorship.

Only three historical completed-input handoffs change: author100k assembly,
author copy-pressure recovery, and inherited independent C3. The old assertions
require zero charged bytes or no pending assembly immediately on completion.
Those would fail against the accepted production ownership rule. Current
production keeps exact owned parts **and** the contiguous copy charged until a
real codec job lease accepts the input. The candidate asserts that double charge,
same-object exact completing-frame retry without another allocation, admission
before assembly removal, continued exact lease ownership/charge after removal and
worker settlement until explicit caller release, and zero after release/expiry. It retains
unchanged malicious graph, semantic namespace, Unicode, deletion, concurrency,
long-history, copy-pressure, worker failure, timeout and resource bounds.

The inherited C3 also includes the previously reviewed mandatory framing fields
(`operation:text`, `replica:1`, `parameters:null`) on its original pressure frames.
Its pressure, recovered bytes and finite resource ceilings stay intact. Explicit
public Node imports make the copied probes lintable; they change no assertions.
The zero-filled8MiB pressure material is deliberately invalid text, so its actual
worker refusal must preserve confirmed input and release the accepted job lease.
The pure `IntentRegistry` remains a serialized model, never PostgreSQL durability
or authorization proof.

The eight canonical modules are **not copied into this checked-in fixture**.
`scripts/check_live_codec_production.py` stages their exact hash-pinned current
bytes into a temporary read-only Docker overlay, together with these tests and
supports. Inventory compares overlay bytes with the actual application test
image's canonical sources, verifies the exact locked dependency versions and
license files, and inspects public dependency **and peer** resolutions for single
Yjs/CodeMirror state/view package roots. Required peers must resolve; an optional
peer is recorded as actually present or absent, never an invented graph entry.
Links point only to declared `/app/apps/web/node_modules/*` and server `lib0/ws`
entry points already installed in that image. No host dependency, private package
API, package installation or application service is added.

After an independent review and the root's explicit serial Docker grant, use a
clean immutable candidate checkout and its already built application **test**
image carrying the exact `com.flux.commit` label:

```sh
FLUX_LIVE_CALIBRATION_GRANTED=228 python3 scripts/check_live_codec_production.py \
  --image flux-test:CURRENT_ISOLATED_PROJECT \
  --evidence /tmp/flux228-current-canonical-codec
```

The evidence directory must be new. The runner uses the inspected immutable image
ID, not a mutable tag after inspection. It builds/installs nothing. Inventory is
bounded30s; the full offline sequential corpus is bounded120s, with Node's finite
90s test ceiling and unchanged canonical100ms worker /2s bootstrap /3s admission
deadlines. Each container has actual512MiB RAM/swap ceiling,2CPU,64PIDs, no network,
read-only filesystem, dropped capabilities and no new privileges. It records
actual source/image/container/dependency/module hashes, caps, actual container
limits/OOM/exit, raw inventory/TAP, and exact owned-container cleanup. It requires
42/42 with0 failures/skips/cancellations/todos. Existing images are caller-owned
and never deleted by this runner. The staging directory is removed on exit.
Capture reads at most4096 bytes per pipe operation and retains at most1MiB inventory
or8MiB TAP **during** the stage, rather than checking only after an unbounded run.
Overflow/deadline interrupts the CLI child with finite termination/kill waits,
removes the exact owned container and fails while retaining the bounded raw prefix.
The fixture uses Docker's public `--log-driver=none` so the daemon does not create
another unbounded log copy; attached stdout/stderr remain the bounded raw evidence.
See [Docker's run reference](https://docs.docker.com/reference/cli/docker/container/run#logging-drivers---log-driver).
No capture-limit failure can become42/42 or a complete inventory.

Neither prepared source nor this codec corpus can establish all four gates.
Production common-context/deferred-input lifetime, actual SQL authority and
immutable receipts, current-clock/revocation handoffs, two independent API
processes/restart, public HTTP/MCP/native ownUndo, DOM author/cursor behavior,
closed-socket resource settlement and the unchanged9-case2160-sample full-path
p95≤200ms gate still need their respective candidate-pinned actual checks. No
logical byte counter is claimed as RSS. The development-only feature stays
disabled by default until complete acceptance.
