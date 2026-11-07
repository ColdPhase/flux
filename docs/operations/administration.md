# Administration in the app

The operator runs the server; the people who use Flux run their own company and its spaces. There is no
server-wide administrator account: everything on this page is done in the app by the company's **owners**
and **admins** and by each space's own admins, and the [settings file](configuration.md) is the operator's
only lever over the whole instance.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screens/people-computer-dark.webp">
    <img src="../assets/screens/people-computer-light.webp" width="62%" alt="Settings, People on a computer: Riverside Makers has four people, Ada Kowalska as Owner, Jonas Berg as Member, Basia Wrona as Admin and Tomasz Lis as Guest, each with a Change button, and the AI row below with Turn off AI.">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screens/people-phone-dark.webp">
    <img src="../assets/screens/people-phone-light.webp" width="22%" alt="The same page on a phone, scrolled to the list: the end of the invite form, the four people with their roles and Change buttons, and the AI row.">
  </picture>
</p>

<p align="center"><sub>Settings → People on a 1440&nbsp;px computer and a 390&nbsp;px phone, in the light and the dark theme your browser asks for.</sub></p>

## The company and its spaces

One Flux is one company. The first account sets it up and owns it, with the default space **Everyone**,
which holds the whole company. Everything else people do together happens in **spaces**: a space can be a
department, a team or a project. You see only the spaces you were added to, and the sidebar lists exactly
those. **New › Space** is one window: a name, the people (chosen from the company), an AI switch that starts
on, and **Create space**. You are the new space's admin.

## People and roles

**Settings › Company** holds the company's name and its people.

| Role | Can |
| --- | --- |
| **Owner** | Everything an admin can do, and add or remove owners. |
| **Admin** | Add and remove people, change roles, change every space and delete any space except Everyone. |
| **Member** | Be in Everyone, start spaces and see the ones they are added to. |
| **Guest** | See only the spaces they are added to, and never have AI. |

Owners and admins add someone who already has an account with **Add someone** (by their email
address), change a role, or remove a person. Anyone can **Leave** the company, except its last owner.
Removing someone takes effect on their very next request; their own agents stop with them.
**Settings › Company** lists people who left or were removed, with **Restore**: they sign in as usual
and are in Everyone again, and other spaces are added by hand. Below that it lists every space, so
an owner or admin can add themselves to one or delete it; their sidebar, search and Inbox hold only the
spaces they belong to.

Each space has its own settings (**⋯ › Settings** in its header): its name, its people, the AI switch,
**Leave space** and, for its admins, **Delete space…**. A space has two roles, **Member** and **Admin**.
Its creator is an admin and can make others admins. Deleting asks first, names the space and erases
everything in it, including its conversations, tasks, Wiki pages and maps. Everyone cannot be deleted
or left. The full rules are in the [access policy](../development/access-policy.md#rules).

## Invite links

For someone who has no account yet, a company owner or admin chooses **Invite with a link** in
**Settings › Company**. A link joins the company, and the person is then added to spaces from each
space's people. With [single sign-on](single-sign-on.md) there are no links: everyone the provider
lets in joins on their first sign-in.

- **Joins as**: member or guest, or admin when the creator is an owner. Never owner.
- **Only for (optional)**: an email address. Empty means whoever opens the link first.
- **Works for**: 1, 7 or 30 days.

Flux copies the link; it sends no email itself, so send it yourself. The link works once. Pending
links are listed in the same place, where any owner or admin can copy or revoke them. The person
signs in or creates an account under the instance's sign-up rule: an invite never opens sign-up that
`FLUX_SIGNUP` or [single sign-on](single-sign-on.md) has closed. Changing `FLUX_AUTH_SECRET` voids
every pending link.

<p align="center">
  <img src="../assets/screens/invite-link.webp" width="48%" alt="Invite with a link in People: Joins as Member, Works for 7 days, the Create invite link button, and the new link with a Copy link button and the note that it works once and Flux does not send it.">
  <img src="../assets/screens/join-page.webp" width="48%" alt="The page the link opens: Join Riverside Makers, with the line that Ada Kowalska invited you as a member, a Sign in to join button and a Create an account button.">
</p>

<p align="center"><sub>Creating the link in People, and the page it opens for the person who receives it.</sub></p>

## AI in a space

Each space has an **AI** switch in its settings, on by default. Its admins, and the company's owners and
admins, turn it off or on for that space. There is no switch for the whole Flux:

- **Off**: no agent, assistant or connected MCP client reads or acts in the space, including each
  member's own. `/ai` answers "AI is off in this space" and the Owner picker lists people only. Work
  an agent had started stops before its next change. People keep working as before.
- **On again**: assistants and connected agents can work there again with the access they had.
  Nothing that was stopped starts again by itself.

The instance-wide switches for owners' AI connections and the assistant are
the operator's ([AI providers](configuration.md#ai-providers)), and so is the
[agent runtime](agent-runtime.md). The space switch can only narrow them. The contract is
[AI in a space](../product/assistant.md#ag-10--ai-in-a-space).

## Encrypted spaces

An owner can create a space with **Encrypt this space**. Its content is encrypted on the server, AI
is always off there, and after every server restart the space waits until an owner or admin unlocks
it with their own unlock password. A recovery code is shown once at creation. If every password and
the recovery code are lost, nobody can recover the space, the operator included. The creation and
unlock interface arrives with [#670](https://github.com/ColdPhase/flux/pull/670); what the operator
does is in [operating encrypted spaces](encrypted-spaces.md).

## Agents and connections

**Settings → AI** is where each person creates their own agent, connects an MCP client
such as Claude Code or Codex to the projects they choose, adds an AI provider key, and, when the
operator allows it, signs in with their own Claude or ChatGPT subscription. Every connection lists
the projects and actions it may use and can be revoked there. [Connect your own
agent](../../README.md#connect-your-own-agent) walks through it.

## Personal settings

Each person manages their own **Account** (name, email, password and signed-in sessions, which they
can end), **Appearance** (light, dark or system; text size), **Notifications** (what reaches the
Inbox, push and email, quiet hours) and **Keyboard shortcuts**. On a computer,
Settings opens from your name at the bottom left → **All settings**.

## What only the operator can do

| Task | How |
| --- | --- |
| Who may create accounts | `FLUX_SIGNUP`, [single sign-on](single-sign-on.md) |
| Email, push, link cards, live editing | The [configuration reference](configuration.md) |
| Owners' AI connections, assistant, agent runtime | [AI providers](configuration.md#ai-providers), [agent runtime](agent-runtime.md) |
| Recover a person's single sign-on link | `./flux identity link` / `unlink` ([single sign-on](single-sign-on.md)) |
| Export a project as files | `./flux export` ([project export](export.md)); project managers can also export from the app |
| Backups, restores, upgrades | [Backup and restore](backup-restore.md), [upgrade](upgrade.md) |
