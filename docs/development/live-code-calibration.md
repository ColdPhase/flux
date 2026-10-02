# Local high-resolution code calibration (#63)

Chosen 2026-09-30 before implementation. This bounded profile extends the
existing authorized Flux-cookie / media-gate TURN harness, not a new media API.
The restrictive test firewall blocks all client UDP except Docker DNS and all
direct TCP/7881, including alternative SFU interface addresses.
It is calibration evidence for AC-2, not acceptance of all quality targets.

Run a selected `code-1440p` profile with two participants, then four participants
and two shares. A deterministic known canvas source is 2560×1440 with 14px code and
16px terminal text, scrolls predictably and carries a binary frame counter.
The glyph family is explicitly Liberation Mono, installed in the pinned browser
image. Generic monospace resolved differently between source/reference contexts
in the initial corpus; record source/reference glyph advances so this cannot be
mistaken for codec image error.
The first share uses real getDisplayMedia on an isolated fullscreen Xvfb
display; the second uses canvas.captureStream. Publish one VP8 layer, 15fps
target, the production 3.5Mbit/s ceiling and maintain resolution. These are harness settings, not receiver performance. No physical
desktop, microphone or camera is captured.

Retain raw timestamped sender/receiver getStats snapshots, interval encoded and
decoded frames/fps/bitrate/loss/jitter, actual dimensions, selected TLS-relay
candidates and SFU CPU/memory/egress windows. At each receiver retain an actual
decoded PNG at natural resolution, a matching known source PNG/crop reconstructed
from its embedded frame marker, plus selected 1:1 and 2× text views. Marker
progress measures fresh delivery; source/receiver timestamp pairing is a local
same-host estimate, not synchronized remote glass-to-glass latency.

First natural-size frame time and image error are observations. No arbitrary
image-error or receiver-fps threshold will certify readable text before an
independent peer inspects the original pixels and calibrates criteria. Harness
integrity gates require real media, fresh counters, identified source frames,
TLS-relay transport and valid resource windows. The calibration SDK clients
explicitly use relay-only ICE; this forced transport is not evidence of the
production automatic fallback. A separate rejoin through the unchanged Flux UI
uses its automatic ICE policy and exercises actual diagnostics and Fit/1:1/zoom. Downscaling/dropped frames must
remain visible in the results. Existing revocation and sign-out cases remain in
the selected run. The default legacy profile stays available.

The existing on-demand diagnostics now use the shared receiver
interval/unknown semantics and actual raw receiver reports; missing counters
and resets must not become zero loss or a good connection. This integration does not change provisional warning
thresholds or the existing screen-selection/focus/zoom surface.

The [dated measured checkpoint](evidence/live-turn/2026-09-30-code/README.md)
pins production and harness source, actual decoded/sent/encoded intervals,
original receiver pixels, source-reference limits, resource windows, the real
product diagnostic path and retained diagnostic failures. It is calibration
evidence, not full #63 acceptance.

Physical platforms, real speech/motion/camera quality, weak individual receivers,
public restrictive networks and verified k3s remain required follow-up work.

Method references checked 2026-09-30:
[LiveKit publish options](https://docs.livekit.io/reference/client-sdk-js/interfaces/TrackPublishOptions.html)
describe encoding and simulcast controls; the locked local SDK is authoritative
for supported fields. [Video frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
report frames sent to the compositor, not every decoded frame; getStats counter
deltas therefore supply receiver fps and callbacks supply audit images/markers.
