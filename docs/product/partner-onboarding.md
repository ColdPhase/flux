# Partner onboarding

For a [design-partner team](design-partners.md) trying Flux before or around v0.1. It takes
about half an hour: install, connect your own agent, run one journey on your own project, and
tell us what happened. It links to the README instead of repeating it, so the steps stay current.

## Before you start

- **Flux is pre-release.** There is no upgrade promise yet. Use a real project, but nothing
  sensitive: no customer data, secrets or private keys.
- **What you need:** Git and Docker Engine (or Docker Desktop) with Compose, on a machine you
  control. Nothing else is installed on the host.
- **Note the time.** Write down when you run `git clone` and when each step below works. That is
  the most useful number you can give us ([our own measurements](../development/time-to-first-run.md)).

## 1. Install

Follow the [README quick start](../../README.md#quick-start) exactly as written:

```sh
git clone https://github.com/ColdPhase/flux.git
cd flux
./flux up
```

The first `./flux up` builds Flux and takes a few minutes. It prints the URL, by default
<http://127.0.0.1:8081/>. If port 8081 is taken, start with `FLUX_PORT=8090 ./flux up`.
If you want to look around first, `./flux demo` adds a sample workspace and prints two logins.

If anything needed knowledge that the README does not give you, that is a bug in the README.
Report it with the [feedback form](#5-give-feedback).

To let teammates on other computers use the same installation, the operator puts it behind HTTPS
and sets `FLUX_PUBLIC_ORIGIN` ([operations](../operations/README.md),
[containers](../development/containers.md)). For a first look, one person on one machine is enough.

## 2. Your account and project

1. Open the URL and create an account.
2. Create your first project. Flux asks for a name for your space; use your team's name.
3. A new project is restricted. Open its **Who can see this** to add the teammates who have
   accounts on the same installation.

## 3. Connect your own agent

Your own MCP client, such as Claude Code or Codex, reads the projects you grant it, with your own
model account. Flux never sees that account. Follow
[Connect your own agent](../../README.md#connect-your-own-agent) in the README. It is written
for the demo data; on your own project the steps are the same:

1. Open Settings → **Agent connections (MCP)**.
2. Create your personal agent and grant it your project with **Read and propose**.
3. Add Flux to your client with the commands the page shows, sign in and allow access.

Claude Code has completed this sign-in; the Codex commands have not yet been run against Flux
([#320](https://github.com/ColdPhase/flux/issues/320)). Tell us which client you used and whether
it worked.

## 4. The first journey

Do this on your real project, with at least one teammate if you can. It is the journey Flux is
built for: from a discussion to a decision and a task, and back again after a break.

1. **Talk.** Post the question your team is working on in the project conversation, and reply
   to each other there.
2. **Turn a message into a task.** Use the message's action to make a task, and give it an owner.
3. **Decide.** Propose a decision from a message, with its reason, and have someone accept it.
   The decision shows under the message it came from.
4. **Ask your agent.** In your MCP client, ask: "Using Flux, what is this project working on,
   and what is still open?" Check the answer against what you see in Flux. A suggestion from your
   agent waits in Flux for a person to review it.
5. **Come back later.** After a day or more away, open Flux. Can you tell what changed, why, and
   what you should do next, without asking anyone? This is the step we most want to hear about.

Optional: open the same installation on your phone and add it to your home screen. Installing
and notifications need HTTPS on a phone ([phone and tablet](mobile-pwa.md)).

## 5. Give feedback

- **Each week**, and whenever something gets in your way, open a
  [partner feedback issue](https://github.com/ColdPhase/flux/issues/new?template=partner-feedback.yml).
  Say what you tried to do, what happened and what you did instead. Real examples help more than
  ratings.
- **A clear bug** can use the [bug report](https://github.com/ColdPhase/flux/issues/new?template=bug.yml).
  Questions go to [Discussions](https://github.com/ColdPhase/flux/discussions).
- **A security problem** goes through
  [private reporting](https://github.com/ColdPhase/flux/security/advisories/new), never an issue.
- Issues are public. Remove tokens, passwords, personal data and private project content from
  text, logs and screenshots.

We aim to answer every partner report within 2 working days. Your report becomes evidence in an
issue, in your words. It is not a promise that we will build it exactly that way; what gets built
goes through the normal issue and decision process.

## Keeping it running

- `./flux down` stops Flux and `./flux up` starts it again with your data.
- Take a backup with `./flux backup` before `./flux upgrade`
  ([operations](../operations/README.md)).
- `./flux reset` deletes all data after a confirmation. Do not use it on the project you are
  testing.
