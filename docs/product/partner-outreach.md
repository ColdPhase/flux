# Design-partner outreach kit

- **Status:** drafts for the founders, 2026-10-30. Part of L-4 in the
  [v0.1 launch plan](launch-v0.1.md), tracked in [#308](https://github.com/ColdPhase/flux/issues/308).
  Prepared by PelikanFix16 (took over from Zamojski5 on 2026-10-30 by founder direction).
- **Basis:** rules 16 and 17 of the [delivery playbook](playbook-the-5.md). The profile of the teams to
  look for is in [design partners](design-partners.md). What a partner does is in the
  [onboarding guide](partner-onboarding.md). The numbers we read afterwards are in
  [lead measures](lead-measures.md).
- **Who sends:** a founder, personally, from their own account. **Agents never contact anyone or post
  for the founders.** They draft this kit and keep it accurate. The shortlist, names, replies and call
  notes stay outside this repository.

## What the founders do

These are the human steps. Everything else in this file supports them.

1. **Pick candidates.** Start with more teams than the 3 to 5 slots, spread across the four
   [profiles](design-partners.md#four-profiles). Prefer teams you do not know personally: friends and
   family feedback misleads (rule 17). Screen each against the four conditions with public evidence
   ([screening](#screening-before-the-first-message)).
2. **Send the first message** ([template](#1-first-message)), one per team, written for that team with
   one real detail. No bulk sends, no pitching in their issue tracker.
3. **Follow up once**, seven days later ([template](#2-one-follow-up)). Then stop.
4. **Hold the intro call**, 30 minutes ([agenda](#intro-call-30-minutes)). Take notes in your private
   tracker ([columns](#the-private-tracker)).
5. **Send the confirmation within one working day** ([template](#4-after-the-call)) with the onboarding
   link and the [partner checklist](partner-onboarding.md#checklist).
6. **Check in with each partner** at the end of weeks 1, 2 and 4 (a message or the optional 30-minute
   call), and answer each feedback issue within 2 working days.
7. **Tell the agent** who agreed to be counted and named, so the [weekly review](weekly-review.md) can
   record it.

Channels, timing and every post outside this repository are the founders' decisions
([launch plan](launch-v0.1.md)).

## Screening before the first message

A team qualifies only if it meets all four conditions of [design partners](design-partners.md#who-we-look-for).
Public evidence helps before anyone writes:

- **Works with coding agents.** A repository with an `AGENTS.md` or `CLAUDE.md` file shows agent use.
  `gh search code --filename AGENTS.md --limit 20 --json repository,path` lists candidates; repeat with
  `CLAUDE.md`. A file alone is not enough: look for recent commits or pull requests written with agents.
- **Small and active.** The number of people who committed in the last 30 days should be 2 to 8:

  ```sh
  gh api "repos/OWNER/REPO/commits?since=$(date -u -d '30 days ago' +%FT%TZ)&per_page=100" \
    --jq '[.[].author.login | select(. != null)] | unique | length'
  ```

  (`date -v-30d +%FT%TZ` on macOS.) Commit authors undercount people who only review or plan, so a count
  of 1 is a question, not a no.
- **Has the problem.** Their issues or pull requests show decisions made in chat or calls and rebuilt
  later. Use their words in the message, not ours.

Use the contact a project publishes for collaboration, or an introduction. Do not use a security
contact or a private address you found by scraping, and do not open an issue in their tracker to pitch Flux.

## Templates

Replace the `{braces}`. Keep the real detail; a template with no real detail is spam. The English and
Polish versions say the same.

### 1. First message

English:

> **Subject:** How does your team pick up work after a break?
>
> Hi {name},
>
> I'm {founder}, one of the two people building Flux, an open source, self-hostable workspace where
> people and coding agents (Claude Code, Codex) work on the same project. I noticed {one real detail,
> for example "the AGENTS.md in your repository" or "your post about handing work to agents"}, and I
> wonder how your team keeps track of what was decided when someone, or an agent, comes back to a
> project after a break.
>
> We are looking for 3 to 5 small teams to try Flux on one real, non-sensitive project for four weeks.
> It is pre-release. You run it yourselves with Docker (`git clone`, then `./flux up`; the first start
> takes a few minutes), connect your own agent client, and send a short note each week about what you
> actually did. In return you get direct contact with us, a first answer within 2 working days, and
> your problems recorded as issues in your own words. Flux is free and open source (AGPL-3.0); there is
> no contract and no exclusive feature.
>
> Could we talk for 30 minutes next week to see whether it fits? A one-line "no" helps us too.
>
> You can look first: <https://coldphase.github.io/flux/start/quick-start/>
>
> Thanks,
> {founder}

Polski:

> **Temat:** Jak Wasz zespół wraca do pracy po przerwie?
>
> Cześć {imię},
>
> Tu {imię założyciela}, jeden z dwóch twórców Flux, otwartego, self-hostowalnego miejsca pracy,
> w którym ludzie i agenci kodujący (Claude Code, Codex) pracują nad tym samym projektem. Zauważyłem
> {jeden prawdziwy szczegół, np. „plik AGENTS.md w Waszym repozytorium" albo „Wasz wpis o przekazywaniu
> pracy agentom"} i ciekawi mnie, jak Wasz zespół pilnuje, co zostało ustalone, gdy ktoś (albo agent)
> wraca do projektu po przerwie.
>
> Szukamy 3–5 małych zespołów, które przez cztery tygodnie wypróbują Flux na jednym prawdziwym,
> niewrażliwym projekcie. To wersja przedpremierowa. Uruchamiacie ją sami w Dockerze (`git clone`, potem
> `./flux up`; pierwszy start trwa kilka minut), podłączacie własnego agenta i raz w tygodniu piszecie
> krótko, co faktycznie zrobiliście. W zamian macie bezpośredni kontakt z nami, pierwszą odpowiedź w ciągu
> 2 dni roboczych, a Wasze problemy zapisujemy w zgłoszeniach Waszymi słowami. Flux jest darmowy i
> otwarty (AGPL-3.0), bez umowy i bez funkcji na wyłączność.
>
> Czy możemy porozmawiać 30 minut w przyszłym tygodniu, żeby sprawdzić, czy to do Was pasuje? Krótkie
> „nie" też nam pomaga.
>
> Możecie najpierw zajrzeć: <https://coldphase.github.io/flux/start/quick-start/>
>
> Dzięki,
> {imię}

### 2. One follow-up

Send once, seven days after the first message, then stop.

> Hi {name}, a short follow-up to my message of {date}. If now is not a good time, I won't write
> again. If you would rather look first, the quick start is here:
> <https://coldphase.github.io/flux/start/quick-start/>, and `./flux demo` gives you a sample project
> to click through. Either way, thank you for reading.
>
> Cześć {imię}, krótkie przypomnienie mojej wiadomości z {data}. Jeśli to nie jest dobry moment, nie
> napiszę ponownie. Jeśli wolicie najpierw zajrzeć: <https://coldphase.github.io/flux/start/quick-start/>,
> a `./flux demo` da Wam przykładowy projekt do oglądania. Dziękuję w każdym razie.

### 3. A "no" or "not now"

Thank them and ask one optional question, because a reason is data. Do not ask again.

> Thank you, {name}, that is useful to know. If you have a minute: what do you use today to keep
> decisions and handoffs together? No need to answer. We won't write again. If you ever want to try
> Flux, the door is open: <https://github.com/ColdPhase/flux>.
>
> Dziękuję, {imię}, to dla nas ważna informacja. Jeśli masz chwilę: czego używacie dziś, żeby decyzje
> i przekazania pracy były w jednym miejscu? Nie musisz odpowiadać i nie napiszemy ponownie. Gdybyście
> kiedyś chcieli spróbować, zapraszamy: <https://github.com/ColdPhase/flux>.

Record the reason in the private tracker. A "no" is not a failure of the profile; it is evidence about
the profile.

### 4. After the call

Send within one working day, only to a team that meets all four conditions and agreed.

> Thanks for the call, {name}. As agreed: one real, non-sensitive project in Flux for four weeks, a named
> contact ({contact}), and a short feedback note each week. We answer within 2 working days.
>
> Everything you need is here: the [onboarding guide](https://github.com/ColdPhase/flux/blob/main/docs/product/partner-onboarding.md)
> and its checklist, and the [documentation site](https://coldphase.github.io/flux/). Please write down
> the time you start `git clone` and when each step works: that number helps us most. Send the first
> feedback through <https://github.com/ColdPhase/flux/issues/new?template=partner-feedback.yml> within
> the first week. The issue is public, so please keep secrets and private content out of it.
>
> Our next check-in: {date}. If anything blocks you before then, write to me directly.
>
> Dzięki za rozmowę, {imię}. Jak ustaliliśmy: jeden prawdziwy, niewrażliwy projekt we Flux przez cztery
> tygodnie, wyznaczona osoba kontaktowa ({kontakt}) i krótka notatka co tydzień. Odpowiadamy w ciągu
> 2 dni roboczych. Wszystko, czego potrzebujecie, jest w
> [przewodniku](https://github.com/ColdPhase/flux/blob/main/docs/product/partner-onboarding.md) z listą
> kontrolną i na [stronie dokumentacji](https://coldphase.github.io/flux/). Zapiszcie proszę godzinę
> startu `git clone` i moment, w którym działa każdy krok. Pierwszą opinię prześlijcie w pierwszym
> tygodniu przez formularz powyżej; zgłoszenie jest publiczne, więc bez sekretów i prywatnych treści.
> Następny kontakt: {data}. Jeśli coś Was zablokuje wcześniej, piszcie bezpośrednio.

## Intro call (30 minutes)

The goal is to find out whether this team is a design partner, not to sell. Listen more than you
talk. Do not promise features: a need is evidence, not a commitment (rule 16).

| Time | What | Notes |
| --- | --- | --- |
| 0:00 to 0:03 | **Hello.** Who we are, why we asked them, that the call is 30 minutes. | One sentence on Flux: people and agents on the same project, with decisions and handoffs kept connected to the conversation they came from. |
| 0:03 to 0:13 | **Their situation.** Ask for the last real example. | "Tell me about the last time someone came back to a project after a break, or took over from an agent. How did they find out what was current?" Where do discussions, decisions and tasks live today? Which agent clients, how often, on shared work? |
| 0:13 to 0:18 | **Do they qualify?** | The four conditions: weekly agent use on shared work; the problem; 2 to 8 people with someone who can run Docker; one real non-sensitive project for four weeks with a named contact. "Would you try this if you did not know us?" Anything that sounds like a favour is a no for now (rule 17). |
| 0:18 to 0:24 | **What we ask and give.** | The [ask and the offer](design-partners.md#what-we-ask-of-a-partner). Flux is pre-release, with no upgrade promise, so nothing sensitive. A first answer within 2 working days. Free and open, no exclusive features. Show the demo for at most five minutes if asked: `./flux demo`. |
| 0:24 to 0:28 | **Consent and dates.** | May we count you as an outside install in the weekly review? May we name you in the build log (the default is no)? Who is the named contact? Date of the first check-in. |
| 0:28 to 0:30 | **Close.** | Repeat what happens next and who sends what. Thank them whatever the answer. |

After the call, write the notes in the tracker the same day, in their words.

## The private tracker

Keep it in a place only the founders can read (a private note or sheet). It is not in the repository
because it names people. These columns are enough:

| Column | Why |
| --- | --- |
| Team (private), profile A to D, how you found them | Spread of profiles, and whether we are only reaching friends |
| Date of the first message, follow-up, reply, call | Reply rate and speed |
| Meets conditions 1 to 4 (yes, no, unsure) | Rule 17 |
| Reason for a "no" | The most useful data of the outreach |
| Start date, install time from `git clone`, agent client | Feeds lead measures 1 and 4 |
| Weeks active, last feedback issue | Who went quiet |
| Counted as an install (yes or no), may be named (yes or no) | The consent the weekly review needs |

Count how many were contacted, replied, held a call and started. Those four numbers are the outreach
funnel; we have no reply rate yet and will not guess one.

## What agents do

- Keep this kit, the [onboarding guide](partner-onboarding.md) and the
  [feedback form](../../.github/ISSUE_TEMPLATE/partner-feedback.yml) accurate when the README or the
  launcher changes.
- Answer feedback issues and outside pull requests within 2 working days. An agent answering on GitHub is
  support, not outreach.
- Prepare the [weekly review](weekly-review.md). Draft a message for a founder when asked; never send it.
