# k3s research and render archive — 2026-09-30

This bundle records source/configuration research and a Docker-only render and
relative-key startup probe for #63. It does not record a Kubernetes install,
external media route or physical-device acceptance.

The implementation coordinator produced the [render/probe record](README.md).
An independent agent inspected the original seven artifacts and primary-source
pins in [the research report](independent-research.md). The unchanged original
report is [preserved here](independent-research.original.md), SHA256
`a6b8aa04c3e0b0a65b35775b17ac3d0bac9848143382fd99ec25949ae1574491`.
The readable copy changes only temporary artifact/source-directory references.

[evidence-sha256.json](evidence-sha256.json) retains the original seven file
hashes. The subsequent [supplemental manifest](supplemental-probe-sha256.json)
pins the three repeat-probe files that close the initial runtime-image/version
provenance gap: exact image ID/digest, server version/startup and loopback HTTP
health responses. The original review's earlier evidence limit is retained as
written. All ten supplied hashes were recomputed while archiving.

The disposable mock key fixture, empty first startup log, chart/source clones
and downloaded tool/archive binaries are excluded. No real key or certificate
is included. The chart archive checksum and renderer version remain in the
record; candidate values/render use documentation addresses and Secret names.

The private `livekit` service route is
[proposed for peer agreement](https://github.com/ColdPhase/flux/issues/63#issuecomment-5909081168).
Node InternalIP, host-network PodIP, EndpointSlice and bound private address
must align, with persistent operator firewall protection. Both inherited RTC
range endpoints must be zero for mux UDP/7882. A relative `keys.yaml` mount was
not an observed blocker: the pinned image started with mode 0600 and refused
mode 0644. The public k3s, external network, restart/rollback and device gates
in [the deployment contract](../../../live-media-k3s.md) remain open.
