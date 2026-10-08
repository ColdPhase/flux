# Computer shell review fixes — #340 / PR #357

Accepted peer correction, 2026-10-08, under the fixed [F-026 final design](final/README.md), §4 Computer and S13. This finishes the three reviewed defects in the existing part-1 PR. It does not accept the separate focus/header work, Home Stop (#342), external-agent Stop (#347), or the whole application.

## Required behavior

- The sidebar card represents a real own-assistant run. An older read or Stop completion cannot replace newer truth or another identity/lifetime. Terminal runs remove the card; a pending or failed Stop cannot be called successful. Polling, stream and focus keep refreshing current truth through the existing permission-backed API.
- The 64px rail preserves icon navigation and has a separate native Stop button, outside its conversation link. Keyboard focus and activation work; coarse-pointer Stop remains at least44 CSS px. Expanded Stop keeps its inline error message and actual pending feedback.
- A compact Stop failure uses readable complete words in the existing F-026 inverted-toast style outside the icon rail. The notice belongs only to the current WorkingAgent instance/identity; terminal state, identity change or unmount removes it. A late old failure cannot create it again. Dismiss clears only local feedback and never changes the server run. Retry remains the same real Stop button/API.
- The Search target remains44 CSS px. Only finite0.001px measurement noise is tolerated, after the opening animation settles;43.5/43.75/43.99 and non-finite values are rejected. Do not round away real undersizing.

## Evidence and scope

The actual old source showed a transient returned working card after real Stop and no503 failure feedback in both Chromium and WebKit. The first compact-error correction kept text inside its40px box but rendered fragmented letters at200% text. That image is retained as an unsuccessful visual outcome; passing overflow assertions alone does not accept readability.

Verify actual API/persistence and live Chromium/WebKit flows: held real pre-Stop response, fresh stopped/empty answer, old response release; keyboard expanded/rail Stop; failed Stop with unchanged server state, local Dismiss and genuine retry; late read/Stop/failure across actual sign-out/new identity; portal cleanup on unmount/terminal. Verify light/dark1440×900 and1280×800, coarse44px controls, visible focus, reduced motion, and complete readable error words at100/200% text. Use unmodified raw captures and a fresh independent neutral visual reviewer. No text scaling, hidden controls, invented success, private browser patches or ignored unknown errors.

The controlled public fetch probe delays only genuine HTTP responses and preserves AbortSignal behavior. A canceled old read is recorded as canceled, not claimed delivered. The existing TEST ONLY Anthropic fixture exercises real worker/API/storage behavior without proving vendor compatibility or billing. Independent exact-head source/behavior review and eligible current Code Owner approval remain separate gates.
