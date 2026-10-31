# Administration in the app

The operator runs the server; the people who use Flux run their own spaces. There is no server-wide
administrator account: everything on this page is done in the app by a space's **owners** and
**admins**, and the [settings file](configuration.md) is the operator's only lever over the whole
instance.

<!-- MEDIA SLOT (#780, after #763 round 2): Settings → People on a computer and a phone, light and dark. -->

## Spaces

A **space** (a workspace in the API and the documentation) holds projects, people and their
conversations. Whoever creates a space is its owner. The first project someone sets up creates their
first space with it. Each person can belong to several spaces with a different role in each.

## People and roles

**Settings → People** lists your spaces; open one to see who is in it.

| Role | Can |
| --- | --- |
| **Owner** | Everything an admin can do, and add or remove owners. |
| **Admin** | Add and remove people, change roles, manage every project, turn AI off or on. |
| **Member** | See projects open to the whole space and the ones given to them. |
| **Guest** | See only the projects given to them. |

Owners and admins add someone who already has an account with **Add someone** (by their email
address), change a role, or remove a person. Anyone can **Leave** a space, except its last owner.
Removing someone takes effect on their very next request; their own agents stop with them.

Inside a project, its managers (owners and admins) choose under **People** whether it is open to
the whole space or only to the people listed, give one person **Can read** or **Can write**, or keep
someone out entirely. The full rules are in the [access policy](../development/access-policy.md#rules).

## Invite links

For someone who has no account yet, an owner or admin chooses **Invite with a link** in the space's
People:

- **Joins as**: member or guest, or admin when the creator is an owner. Never owner.
- **Only for (optional)**: an email address. Empty means whoever opens the link first.
- **Works for**: 1, 7 or 30 days.

Flux copies the link; it sends no email itself, so send it yourself. The link works once. Pending
links are listed in the same place, where any owner or admin can copy or revoke them. The person
signs in or creates an account under the instance's sign-up rule: an invite never opens sign-up that
`FLUX_SIGNUP` or [single sign-on](single-sign-on.md) has closed. Changing `FLUX_AUTH_SECRET` voids
every pending link.

<!-- MEDIA SLOT (#780, after #763 round 2): creating and copying an invite link; the join page. -->

## AI in a space

At the end of a space's People, **AI in <space>** shows whether agents and assistants may work
there. Owners and admins turn it off or on for the whole space:

- **Off**: no agent, assistant or connected MCP client reads or acts in the space, including each
  member's own. Work they had started stops. People keep working as before.
- **On again**: assistants and connected agents can work there again with the access they had.
  Nothing that was stopped starts again by itself.

The instance-wide switches for owners' AI connections, the assistant and background suggestions are
the operator's ([AI providers](configuration.md#ai-providers)), and so is the
[agent runtime](agent-runtime.md). The space switch can only narrow them. The contract is
[F-029](../product/workspace-ai-lock.md).

## Encrypted spaces

An owner can create a space with **Encrypt this space**. Its content is encrypted on the server, AI
is always off there, and after every server restart the space waits until an owner or admin unlocks
it with their own unlock password. A recovery code is shown once at creation. If every password and
the recovery code are lost, nobody can recover the space, the operator included. The creation and
unlock interface arrives with [#670](https://github.com/ColdPhase/flux/pull/670); what the operator
does is in [operating encrypted spaces](encrypted-spaces.md).

## Agents and connections

**Settings → Agents and AI** is where each person creates their own agent, connects an MCP client
such as Claude Code or Codex to the projects they choose, adds an AI provider key, and, when the
operator allows it, signs in with their own Claude or ChatGPT subscription. Every connection lists
the projects and actions it may use and can be revoked there. [Connect your own
agent](../../README.md#connect-your-own-agent) walks through it.

## Personal settings

Each person manages their own **Account** (name, email, password and signed-in sessions, which they
can end), **Appearance** (light, dark or system; text size), **Notifications** (what reaches the
Inbox, push and email, quiet hours, the morning summary) and **Keyboard shortcuts**. On a computer,
Settings opens from your name at the bottom left → **All settings**.

## What only the operator can do

| Task | How |
| --- | --- |
| Who may create accounts | `FLUX_SIGNUP`, [single sign-on](single-sign-on.md) |
| Email, push, link cards, live editing | The [configuration reference](configuration.md) |
| Owners' AI connections, assistant, background suggestions, agent runtime | [AI providers](configuration.md#ai-providers), [agent runtime](agent-runtime.md) |
| Recover a person's single sign-on link | `./flux identity link` / `unlink` ([single sign-on](single-sign-on.md)) |
| Export a project as files | `./flux export` ([project export](export.md)); project managers can also export from the app |
| Backups, restores, upgrades | [Backup and restore](backup-restore.md), [upgrade](upgrade.md) |
