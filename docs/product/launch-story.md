# Launch story: two founders, two agents

> **Draft for the founders. Agents do not publish it.** Drafted by claude-maurycy on 2026-10-06
> for L-3 of the [launch plan](launch-v0.1.md) ([#307](https://github.com/ColdPhase/flux/issues/307)).
> The founders decide whether, where and when it is posted, and they edit it freely.
>
> **Before publishing, check:**
>
> - the names and roles: the [startup guide](../agents/startup.md) lists Maurycy with Claude Code
>   and Hubert with Codex, so confirm what each of you runs now;
> - the release link and date in the last paragraph (`[link]` placeholders);
> - the v3 quote: #302 records it in English, translated from your chat, so use your own words in
>   the Polish version;
> - any entries added to the [build log](../build-log.md) after 2026-10-06.
>
> Every fact below comes from the build log or the linked pull requests and issues. There are no
> other numbers in it, and none should be added without a source.

## English

### Two founders, two coding agents: building Flux in public

Flux is an open source, self-hostable workspace where people and AI agents work on the same
projects: conversations, and the tasks, documents and decisions that come out of them. We are two
founders. Since 27 September 2026, much of the code has been written by two coding agents, one
working for each of us. This is how it went, with the evidence in the repository.

**The rules.** On the second day we wrote the product foundation and
[delegated delivery](https://github.com/ColdPhase/flux/blob/main/docs/product/autonomy.md) to the
agents. They plan, decide and implement; there is no founder approval queue. We kept three rules
that no agent can bend. `main` is protected, so every change arrives as a pull request. Each pull
request needs approval from the other founder's account, so the agent that wrote a change never
approves it. And the tests are real: the API, PostgreSQL and browser tests run in Docker, and a
review names the commit it tested. When the pull-request workflow grew to the full 10m38s suite,
CI went back to fast checks, and the full suites stayed a Docker run on our own machines
([#143](https://github.com/ColdPhase/flux/issues/143)).

**Our first mistake was process.** The first setup was a custom "paired runner" that drove both
agents ([#7](https://github.com/ColdPhase/flux/pull/7)). Within a day it needed four fixes
([#17](https://github.com/ColdPhase/flux/pull/17), [#21](https://github.com/ColdPhase/flux/pull/21),
[#23](https://github.com/ColdPhase/flux/pull/23), [#31](https://github.com/ColdPhase/flux/pull/31)).
We deleted it. Now each founder runs one agent session, and the two coordinate through GitHub
issues and pull requests ([#32](https://github.com/ColdPhase/flux/pull/32)). Process tooling is
not product progress.

**Then the disk filled up.** Every Docker check built 0.6–4 GB of images and left them behind.
About 60 leftover images and 62 GB of build cache filled a developer's disk
([#71](https://github.com/ColdPhase/flux/issues/71)). The checks now remove exactly the images
they built ([#73](https://github.com/ColdPhase/flux/pull/73)). On 6 October per-run test images
filled the disk twice more, and every Docker check stopped until space was freed. A shared
machine needs a disk guard, and cleanup by a list of what you own, not by excluding what you
think belongs to others.

**Migrations that lied.** On 29 September, branches merged in a different order from their
migration numbers, so a database could claim a schema version it had never applied. The migrator
and the API now require the exact migrations the image expects
([#130](https://github.com/ColdPhase/flux/pull/130)). `max(version)` is not a schema check.

**Stopped sessions.** On 1 October one agent stopped at its weekly usage threshold. The other
kept working on independent tasks and left the paused branches alone. The lesson: one owner per
branch, and handoffs written to survive a stopped session.

**Review catches real things.** On 6 October a review found that any signed-in session could
register OAuth clients. A member could then have passed off a look-alike agent client. It was
fixed the same day ([#294](https://github.com/ColdPhase/flux/pull/294)). The author and the
reviewer each ran the new tests without the fix and watched them fail, so the tests really guard
it.

**Our phones were the hardest review.** On 5 October we opened Flux on our own phones and found
it overwhelming: it was unclear what to tap, and it felt nothing like a messenger
([#264](https://github.com/ColdPhase/flux/issues/264)). We set a phone-first direction
([#266](https://github.com/ColdPhase/flux/issues/266)), and an Apple HIG checklist became the
rule book ([#285](https://github.com/ColdPhase/flux/pull/285)). Then we compared five phone
mock-ups. The third, the desktop look copied onto the phone, got one line: "really ugly …
hard to look at" ([#302](https://github.com/ColdPhase/flux/pull/302)). We chose a calmer
direction, where each AI agent has its own coloured mark that moves only while the agent really
works (proposed in [#304](https://github.com/ColdPhase/flux/pull/304)). A description is not a
design; show rendered screens early.

**What we would tell another team.** Keep the coordination layer as thin as GitHub allows.
Make the reviewer independent of the author, and have them name the commit they tested. Test the
real stack, and clean up after it. Keep a dated log of what went wrong, because that is the part
others can learn from.

**Try it.** Flux v0.1.0 is out: [link]. Clone it, run `./flux up` and `./flux demo`, and connect
your own agent over MCP. Every step above is in the
[build log](https://github.com/ColdPhase/flux/blob/main/docs/build-log.md).

## Polski

### Dwóch założycieli, dwóch agentów: Flux budowany publicznie

Flux to otwartoźródłowa przestrzeń pracy, którą można postawić u siebie. Ludzie i agenci AI
pracują w niej nad tymi samymi projektami: rozmowami oraz zadaniami, dokumentami i decyzjami,
które z nich wynikają. Jesteśmy dwoma założycielami. Od 27 września 2026 roku dużą część kodu
piszą dwaj agenci programistyczni, po jednym dla każdego z nas. Oto jak to przebiegało, z dowodami
w repozytorium.

**Zasady.** Drugiego dnia spisaliśmy fundament produktu i
[przekazaliśmy realizację](https://github.com/ColdPhase/flux/blob/main/docs/product/autonomy.md)
agentom. Planują, decydują i wdrażają; nie ma kolejki do akceptacji przez założycieli.
Zostawiliśmy trzy zasady, których żaden agent nie może nagiąć. Gałąź `main` jest chroniona, więc
każda zmiana przychodzi jako pull request. Każdy pull request wymaga zatwierdzenia z konta
drugiego założyciela, więc agent, który napisał zmianę, nigdy jej nie zatwierdza. Testy są
prawdziwe: API, PostgreSQL i testy w przeglądarce działają w Dockerze, a przegląd podaje commit,
który sprawdził. Gdy workflow dla pull requestów urósł do pełnego zestawu trwającego 10 min 38 s,
CI wróciło do szybkich testów, a pełne zestawy zostały w Dockerze na naszych maszynach
([#143](https://github.com/ColdPhase/flux/issues/143)).

**Pierwszy błąd był procesowy.** Na początku zbudowaliśmy własny „paired runner”, który sterował
oboma agentami ([#7](https://github.com/ColdPhase/flux/pull/7)). W ciągu doby wymagał czterech
poprawek ([#17](https://github.com/ColdPhase/flux/pull/17),
[#21](https://github.com/ColdPhase/flux/pull/21), [#23](https://github.com/ColdPhase/flux/pull/23),
[#31](https://github.com/ColdPhase/flux/pull/31)). Usunęliśmy go. Teraz każdy z założycieli
prowadzi jedną sesję agenta, a obaj agenci uzgadniają pracę przez issues i pull requesty na
GitHubie ([#32](https://github.com/ColdPhase/flux/pull/32)). Narzędzia do procesu to nie postęp
produktu.

**Potem zapełnił się dysk.** Każdy test w Dockerze budował 0,6–4 GB obrazów i je zostawiał.
Około 60 porzuconych obrazów i 62 GB cache budowania zapełniły dysk programisty
([#71](https://github.com/ColdPhase/flux/issues/71)). Testy usuwają teraz dokładnie te obrazy,
które zbudowały ([#73](https://github.com/ColdPhase/flux/pull/73)). 6 października obrazy z
pojedynczych przebiegów testów zapełniły dysk jeszcze dwa razy i wszystkie testy w Dockerze stanęły,
dopóki nie zwolniono miejsca. Wspólna maszyna potrzebuje strażnika miejsca na dysku i sprzątania
według listy tego, co jest twoje, a nie przez pomijanie tego, co uważasz za cudze.

**Migracje, które kłamały.** 29 września gałęzie scaliły się w innej kolejności niż numery ich
migracji, więc baza mogła deklarować wersję schematu, której nigdy nie zastosowała. Migrator i API
wymagają teraz dokładnie tych migracji, których oczekuje obraz
([#130](https://github.com/ColdPhase/flux/pull/130)). `max(version)` to nie jest sprawdzenie
schematu.

**Zatrzymane sesje.** 1 października jeden agent zatrzymał się na swoim tygodniowym progu
użycia. Drugi dalej pracował nad niezależnymi zadaniami i nie ruszał wstrzymanych gałęzi. Wniosek:
jedna gałąź ma jednego właściciela, a przekazania pracy pisze się tak, by przetrwały zatrzymaną
sesję.

**Przegląd łapie prawdziwe problemy.** 6 października przegląd wykazał, że każda zalogowana sesja
mogła rejestrować klientów OAuth. Członek zespołu mógłby więc podsunąć podrobionego klienta
agenta. Poprawka weszła tego samego dnia ([#294](https://github.com/ColdPhase/flux/pull/294)). Autor i
recenzent uruchomili nowe testy bez poprawki i zobaczyli, że nie przechodzą, więc testy naprawdę
jej pilnują.

**Najtrudniejszym przeglądem były nasze telefony.** 5 października otworzyliśmy Fluxa na własnych
telefonach i był przytłaczający: nie było jasne, co kliknąć, i w niczym nie przypominał
komunikatora ([#264](https://github.com/ColdPhase/flux/issues/264)). Ustaliliśmy kierunek „najpierw
telefon” ([#266](https://github.com/ColdPhase/flux/issues/266)), a lista kontrolna według Apple HIG
stała się zbiorem zasad ([#285](https://github.com/ColdPhase/flux/pull/285)). Potem porównaliśmy
pięć makiet na telefon. Trzecia, czyli wygląd z komputera przeniesiony na telefon, dostała jedno
zdanie: „naprawdę brzydkie … ciężko na to patrzeć”
([#302](https://github.com/ColdPhase/flux/pull/302)). Wybraliśmy spokojniejszy kierunek, w którym
każdy agent AI ma własny kolorowy znak, poruszający się tylko wtedy, gdy agent naprawdę pracuje
(propozycja w [#304](https://github.com/ColdPhase/flux/pull/304)). Opis to nie projekt;
pokazujcie wyrenderowane ekrany wcześnie.

**Co powiedzielibyśmy innemu zespołowi.** Warstwa koordynacji powinna być tak cienka, jak pozwala
GitHub. Recenzent musi być niezależny od autora i podawać commit, który sprawdził. Testujcie
prawdziwy stos i sprzątajcie po nim. Prowadźcie datowany dziennik tego, co poszło źle, bo z tej
części inni uczą się najwięcej.

**Wypróbujcie.** Flux v0.1.0 jest już dostępny: [link]. Sklonujcie repozytorium, uruchomcie
`./flux up` i `./flux demo` i podłączcie własnego agenta przez MCP. Każdy z tych kroków jest w
[dzienniku budowy](https://github.com/ColdPhase/flux/blob/main/docs/build-log.md).
