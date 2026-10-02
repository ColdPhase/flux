# Confirmed thought capture evidence (#149)

Focused production/UI source `0739dc1968f3e7fff6f91bee7bdbd3351a43c267`, stacked on #134 and #148.
[Metadata](metadata.json) pins the maintained source and realistic fixture viewports.

The [nine Docker journeys](focused-docker-ui.txt) pass: private creation before explicit
confirmation, empty/cancel/blur/IME, literal multiline text, List/Map/navigation/reload,
stable retry after a real committed-but-uncertain response, normal undo, deleted parent,
write downgrade/revocation and route-level private recovery, two-writer version conflict,
recoverable existing-edit failures, actual sign-out/account isolation, and visible touch
controls. They use actual server persistence and a second signed-in author.

[Thirty actual composited contrast measurements](browser-contrast.json) pass at 4.5:1
or above. The harness waits for enabled controls and settled styles, and records exact
selectors/RGB before measurement. An earlier full attempt reported a contrast failure;
that earlier result does not identify its precise cause. The named toolbar selector was
also made unambiguous on touch layouts. The nine current journeys cover those checks. Prior failed attempts are not reported as successful regression.

Separate screenshots cover light/dark desktop, phone and tablet in List/Map capture,
existing edit and failed/conflicting edits. These pictures do not prove behavior.
Current full regression, independent visual review and #136 shared shell integration
are separate acceptance evidence. No physical Android/iPhone/iPad PWA, notification
or complete accessibility acceptance is claimed by these browser fixtures.

The [complete Docker browser regression](full-docker-ui.txt) at `0739dc1`
loads 135 tests: 131 pass, four optional live-media checks skip, zero failures,
410.114 seconds. Its build/type/lint also pass. It predates the visual recovery
wording correction; it is not presented as a full run of that later source.

The [corrected recovery evidence](recovery-correction/metadata.json) pins code
`4a6f51dd51e287fbf743612f0a0a8505f6fa54f4`. Nine affected journeys and thirty contrast checks pass.
The complete failure/conflict next-step text now wraps on its own row above
Save/Cancel; its rendered bounds are checked with one CSS pixel rounding tolerance.
Original screenshots/review are preserved separately from the correction.

The [original independent visual assessment](independent-visual-original.md)
found clipped desktop recovery text; the [fresh correction review](recovery-correction/independent-visual.md)
accepts its resolution and the six supplied corrected states. Neither certifies
behavior, eligible protected-main approval or unprovided Studio/Agents integration.
