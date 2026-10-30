# Launch posts: Show HN, Reddit and a blog post

> **Drafts for the founders. Agents do not post them.** Drafted by claude-hubert on 2026-10-30 for L-3 of the
> [launch plan](launch-v0.1.md) ([#307](https://github.com/ColdPhase/flux/issues/307)), beside the
> [release notes](release-notes-v0.1.0-draft.md), the [video script](launch-video.md) and the
> [story](launch-story.md). The founders decide whether, where and when each is posted, and they edit it freely.
> The tone is plain on purpose: what Flux is, what it does not do yet, how to try it. No claim here is
> bigger than the [README](../../README.md) and the release notes.

## Before any of this goes out

Only a person can do these. Each is a step, not a suggestion.

1. **The release exists.** The final workflow has run on the accepted candidate and the notes are final
   ([CI and releases](../agents/ci-and-releases.md), [#249](https://github.com/ColdPhase/flux/issues/249)). Replace
   every `<VERSION>`, `<RELEASE URL>` and `<VIDEO URL>` below. Do not post before the release link works.
2. **Restate the facts.** Every sentence about what works comes from the release notes. If the notes list a
   known limit, the post lists it too.
3. **Try your own words on a clean machine.** From a new directory, run the README's three lines and follow
   them as written. If a step needs knowledge the README does not give, fix the README first.
4. **Check the rules of the place on the day.** The notes below are dated 2026-10-30 and rules move.
5. **Be there.** Plan the first hours after posting: HN and Reddit threads are answered by the people who made
   the project. The [launch plan](launch-v0.1.md#l-2-a-path-for-the-first-outside-contributor-306) already
   sets a goal of a first answer to any outside issue or pull request within two working days.
6. **Say how it was built.** Most of the code was written by two coding agents under the founders' direction
   ([story](launch-story.md), [build log](../build-log.md)). Say it in the first lines, in your own words, and
   do not let a title hide it or stress it.

## Where it can go (checked 2026-10-30)

| Place | What the rules say | What it means for Flux |
| --- | --- | --- |
| **Hacker News, Show HN** | Primary source: [Show HN guidelines](https://news.ycombinator.com/showhn.html), read on 2026-10-30. The title begins "Show HN". It must be something people can run or hold, "ready for users to try out", ideally without sign-up. You must have worked on it and be around to discuss it. "Don't post quickly-generated one-offs." Do not ask friends to upvote or comment. Blog posts and landing pages are off topic. | Flux qualifies: it runs from a clone in a few minutes. There is no hosted demo (a hosted service is out of v0.1, O-004), so the GIF and the video stand in for a first look. Link to the repository, not to the blog post. |
| **Reddit, r/selfhosted** | Secondary sources only; Reddit was not fetchable from this environment on 2026-10-30. Search results dated March and April 2026 describe a weekly "New Project Friday" megathread, a **three-month minimum age for a shared project**, and a template that asks the poster to state their AI involvement. | The repository was created on 2026-09-26, so by that rule it is old enough on **2026-12-26**. Read the sidebar and the pinned posts first. State the AI involvement plainly (see the draft). |
| **Reddit, r/opensource** | A news item of late October 2026 reports that its moderators banned AI-built projects. Not verified at the source. | Do not post there unless its current rules clearly allow it. |
| **LinkedIn, a blog** | No rules to check. The founders' choice. | Use the blog draft; the [story](launch-story.md) has the Polish text. |

## 1. Show HN

**Link:** `https://github.com/ColdPhase/flux`

**Title options** (80 characters at most; pick one, no capital-letter hype, no superlatives):

- `Show HN: Flux – a self-hosted workspace where people and AI agents share projects`
- `Show HN: Flux – self-hostable workspace for teams that work with coding agents`

**First comment**, posted by the person who submits it, right after the submission:

> Hi HN. Flux is an open source (AGPL-3.0) workspace you run yourself with Docker Compose. People and AI
> agents work in the same project: conversations, and the tasks, decisions and documents that come out of
> them. It is for small software teams that already hand some work to coding agents and want to come back
> after a break and see what changed, what was decided and what is next.
>
> Try it: `git clone --depth 1 https://github.com/ColdPhase/flux.git && cd flux && ./flux up && ./flux demo`.
> You need Git and Docker only. The first start builds the images; on our Linux machine that took about
> three minutes cold and under a minute warm, and longer on a loaded one
> ([measurements](https://github.com/ColdPhase/flux/blob/main/docs/development/time-to-first-run.md)).
> `./flux demo` adds a sample project and two logins. There is no hosted demo, on purpose: Flux is meant to
> run on your own server.
>
> How agents fit: you connect your own Claude Code, Codex or another MCP client to the projects you choose.
> It runs on your computer with your own model account; Flux does not see that account. Decisions are accepted
> by a person, never by an agent. A workspace can also turn AI off completely, and the human journey (return,
> catch up, hand off) works without any AI.
>
> What it is not, yet: <KNOWN LIMITS FROM THE RELEASE NOTES, ONE LINE EACH>.
>
> How it was built: two founders and two coding agents, one working for each of us, in public. Most of the
> code was written by the agents; we set the rules, reviewed, and decided. The build log has the dated record,
> including what went wrong (a custom runner we deleted, a disk that filled, migrations that lied):
> https://github.com/ColdPhase/flux/blob/main/docs/build-log.md
>
> I am here to answer questions, and I would like to hear where the quick start fails for you.

**Likely questions and the honest answers** (keep them short and sourced; do not guess):

| Question | Answer, from the repository |
| --- | --- |
| Why AGPL? | The application is AGPL-3.0; the SDK and contracts are Apache-2.0 ([licensing](licensing.md)). |
| Does it send my data to an AI provider? | Only through an agent you connect or an AI connection the owner sets up; both are off until the operator or owner turns them on, and a workspace can turn AI off ([release notes](release-notes-v0.1.0-draft.md#work-with-your-ai)). |
| Can I use it in production? | `<SUPPORT STATEMENT FROM THE RELEASE NOTES>`. There is no upgrade history before v0.1.0; back up before every upgrade ([upgrade and backup](release-notes-v0.1.0-draft.md#upgrade-and-backup)). |
| How is this different from a chat app plus an issue tracker? | A message becomes a task or a decision in one action and stays linked to its source; the project's conversation, map and wiki are one place; and an agent you connect works inside it with a grant you control. Do not claim more than the README says. |
| Is the code written by AI? | Mostly, under two founders' direction and review; the [story](launch-story.md) says how, and the build log records the mistakes. |

## 2. Reddit, r/selfhosted

**Post only after the rules check above.** Flair: the one the sub asks for new projects, with the AI involvement
stated as the template requires.

**Title:** `Flux: a self-hosted workspace for people and AI agents (AGPL-3.0, Docker Compose)`

**Body:**

> **What it is.** Flux is a workspace you run yourself: project conversations, and the tasks, decisions and
> documents that come out of them, with AI agents that you connect working in the same projects. It is aimed
> at small software teams that already use coding agents.
>
> **How it runs.** One Docker Compose stack: the API, a separate worker, PostgreSQL and a small keyring
> service. `./flux up` builds and starts it; `./flux demo` seeds a sample workspace. A published release
> has a pull-only `compose.yaml`, checksums and an install guide
> ([install from a release](https://github.com/ColdPhase/flux/blob/main/docs/operations/install-release.md)).
> The compose file sets memory limits (`FLUX_API_MEMORY` 2g, `FLUX_WORKER_MEMORY` 1g, `FLUX_KEYRING_MEMORY`
> 128m); I have not measured a minimum machine, so do not read those as sizing advice.
>
> **Operating it.** `./flux backup`, `restore`, `export` and `upgrade`; an HTTPS reverse-proxy guide with
> Caddy; optional single sign-on with your own OpenID Connect provider; email through your SMTP server;
> Web Push for the phone PWA. There is no hosted service. `<IF YOU WANT A LINE ABOUT TELEMETRY, VERIFY IT IN
> THE RELEASE FIRST; OTHERWISE DELETE THIS PLACEHOLDER>`
>
> **AI.** Off until you turn it on. Your own Claude Code, Codex or another MCP client connects to the projects
> you choose, runs on your computer with your own model account, and Flux does not see that account. A
> workspace can turn AI off entirely.
>
> **AI involvement in building it.** Most of the code was written by two coding agents under the direction of
> the two of us, with the dated record in the build log. Tests run in Docker and every change goes through a
> pull request.
>
> **Status.** `<VERSION>` is the first release. Known limits: `<FROM THE RELEASE NOTES>`.
>
> Repository: https://github.com/ColdPhase/flux. Screenshots and a demo GIF are in the README. I would like to
> know where the install fails on your hardware.

## 3. Blog post

**Title:** `Flux <VERSION>: a workspace where people and AI agents share a project`

**Body:**

> Flux is an open source workspace you run on your own server. People and AI agents work in the same
> projects: conversations, and the tasks, documents and decisions that come out of them. Today we are
> publishing `<VERSION>`, the first release.
>
> **The problem.** Small software teams now hand part of their work to coding agents. The work then spreads
> over chats, issue trackers and agent sessions, and after a break nobody can say quickly what changed, what
> was decided and what is next.
>
> **What Flux does about it.** Four things, each of which you can try on the demo data.
>
> 1. *Come back and catch up.* Home shows what changed since you left and one next step.
> 2. *Conversations turn into work.* One action makes a message a task; a decision keeps its reason, and a
>    person accepts it. Both stay linked to the message they came from.
> 3. *Your own agent, with your permission.* You connect Claude Code, Codex or another MCP client to the
>    projects you choose. It runs on your computer with your own model account. Flux gives it a scoped grant
>    and shows what it did, named as the author.
> 4. *One design on the computer and the phone,* installable as a PWA, with an inbox that shows what needs you.
>
> ![The Community garden sensors project on a desktop and Home on a phone](https://raw.githubusercontent.com/ColdPhase/flux/main/docs/assets/readme/conversation-desktop.png)
>
> **Try it.** You need Git and Docker.
>
> ```sh
> git clone --depth 1 https://github.com/ColdPhase/flux.git && cd flux
> ./flux up      # builds and starts Flux, prints its address
> ./flux demo    # sample project and two logins
> ```
>
> **What it does not do yet.** `<KNOWN LIMITS FROM THE RELEASE NOTES>`. There is no hosted service; Flux is for
> people who want to run their own.
>
> **How we built it.** Two founders and two coding agents, one working for each of us, in public. The agents
> plan, decide and implement; we set the rules and what the product is for. We kept the record, including
> mistakes: a custom runner we deleted after a day, a disk that Docker images filled, migrations whose order did
> not match their numbers, and phones that we found overwhelming on the first real look. The
> [story](https://github.com/ColdPhase/flux/blob/main/docs/product/launch-story.md) and the
> [build log](https://github.com/ColdPhase/flux/blob/main/docs/build-log.md) have the details and the links.
>
> **Licence and next steps.** The application is AGPL-3.0, and the SDK and contracts are Apache-2.0. We are
> looking for a few small teams that already work with coding agents and will tell us where Flux fails them
> ([design partners](design-partners.md)); open an issue or write to us.
>
> `<VIDEO URL>`: a 75-second walk through the core journey on the demo data.

## What to check in every draft before posting

- No sentence says "first", "best", "revolutionary", "production-ready" or compares Flux with a named
  product. If you want a comparison, put it in a table with sources.
- Every number has a link. The numbers allowed here are the install times in
  [time to first run](../development/time-to-first-run.md), the memory limits above and the dates in the
  [build log](../build-log.md).
- Nothing here promises a date, a hosted service, a pricing plan or a feature that is not in the release.
- The words about the agents' part in the code are the founders' own.
