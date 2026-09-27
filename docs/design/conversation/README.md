# Project conversation UI checkpoint

Screenshots from the Compose/Playwright journey at 1440×900 desktop and 390×844
phone, 100% browser zoom, one restricted project with two members, a private draft,
a redacted project material and linked replies. They show the current direction C
shell adapted for real conversation and direct capture. The desktop conversation
keeps threads, messages and materials visible together; the phone uses a single
column with the composer anchored below the scrollable content. The audience is
stated by the composer. The material citation names an immutable version.

The first message gives each discussion a stable name in the rail and page
heading, while the date continues to show recent activity. Each reply names its
author, including the signed-in member. The action beside an existing material
version is prominent enough to connect that version to a new reply. These
details respond to the neutral visual review of the earlier screenshot set.
On a scrolled phone, the composer repeats the selected discussion name so the
reply target remains visible when the page heading has left the viewport.

These images are an author self-check. A neutral independent visual review of
the final pinned UI head, compared with `flux-ux-v8.html` at the same viewports,
is still required. Images do not verify focus, auth, retry, or persistence;
the Playwright journey and backend integration checks cover those behaviors.
