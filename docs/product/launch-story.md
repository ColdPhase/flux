# Launch story: two founders, two agents

> **Draft for the founders. Agents do not publish it.** Drafted by claude-maurycy on 2026-10-06
> for L-3 of the [launch plan](launch-v0.1.md) ([#307](https://github.com/ColdPhase/flux/issues/307)).
> Refreshed by claude-hubert on 2026-10-23: the rules paragraph now says what changed on 18 and 23 October,
> and "What changed after 7 October" is new.
> The founders decide whether, where and when it is posted, and they edit it freely.
>
> **Before publishing, check:**
>
> - the names and roles: the [startup guide](../agents/startup.md) lists Maurycy with Claude Code
>   and Hubert with Codex, so confirm what each of you runs now;
> - the release link and date in the last paragraph (`[link]` placeholders);
> - the v3 quote: #302 records it in English, translated from your chat, so use your own words in
>   the Polish version;
> - the build log ends on 2026-10-07: the new section cites pull requests, issues and the
>   [time to first run](../development/time-to-first-run.md) page instead, so check it against what you remember;
> - the lines about Codex ([#660](https://github.com/ColdPhase/flux/issues/660)) and the review rules: change
>   them if the bug is fixed or the rules change again before you post.
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
that no agent can bend. `main` is protected, so every change arrives as a pull request. At first,
each pull request needed approval from the other founder's account, so the agent that wrote a change
never approved it (that changed on 23 October, see below). And the tests are real: the API, PostgreSQL and browser tests run in Docker, and a
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
hard to look at" ([#302](https://github.com/ColdPhase/flux/pull/302)). So on 7 October we drew
the final design ourselves, "Prostota" (simplicity): one calm language on the computer and the
phone, one Inbox for what needs you, and Kreska, a line-drawn face that is the logo and every
agent's icon ([#336](https://github.com/ColdPhase/flux/issues/336)). A description is not a
design; show rendered screens early.

**What changed after 7 October.**

- *We capped the reviews.* Two agents reviewing each other can go on for ever. On 18 October we
  limited a pull request to one full review and one check of the fixes, and a persisting blocker is
  parked instead of looped ([comment on #249](https://github.com/ColdPhase/flux/issues/249#issuecomment-6247024855)).
  The same day we let one agent take over the other's idle issues and group related ones into one pull
  request ([comment](https://github.com/ColdPhase/flux/issues/249#issuecomment-6247887007)). On 23
  October we went further: an author may merge their own pull request when its checks pass and no
  serious review finding is open, and peer review can come before or after
  ([workflow, step 5](../agents/workflow.md#5-review-fix-and-merge), [#656](https://github.com/ColdPhase/flux/pull/656)).
  We chose speed over a second pair of eyes before merge.
- *Our own README was the first thing to break.* On 6 October the first clone on a Mac took 3 min 08 s
  for a 206 MiB download, mostly review screenshots in the history. We archived that evidence
  ([#428](https://github.com/ColdPhase/flux/pull/428), [#619](https://github.com/ColdPhase/flux/pull/619))
  and the README now clones shallow: 17 MB, which took 4 s on a Linux machine on another network
  ([time to first run](../development/time-to-first-run.md)).
- *A real client finds what a fixture does not.* Following our own README with Claude Code, a
  walkthrough found that the default connection could not be approved
  ([#320](https://github.com/ColdPhase/flux/issues/320)). On 16 October Hubert directed that a person may
  grant fewer permissions than a client asks for ([#548](https://github.com/ColdPhase/flux/issues/548),
  merged on 17 October in [#571](https://github.com/ColdPhase/flux/pull/571)). On 23 October the same
  walkthrough with Codex showed that the fix covered only the way Claude Code asks
  ([#660](https://github.com/ColdPhase/flux/issues/660)).
- *Editing together took three steps.* Live movement on a map and shared wiki text arrived on 14 October
  ([#389](https://github.com/ColdPhase/flux/pull/389)), named cursors on 17 October
  ([#585](https://github.com/ColdPhase/flux/pull/585)) and the finished version on 23 October
  ([#613](https://github.com/ColdPhase/flux/pull/613)).

**What we would tell another team.** Keep the coordination layer as thin as GitHub allows.
Make the reviewer independent of the author, and have them name the commit they tested (we kept
that rule for almost four weeks and relaxed it on 23 October to go faster). Test the real stack, and
clean up after it. Follow your own README with the real client, not a fixture. Keep a dated log of
what went wrong, because that is the part others can learn from.

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
każda zmiana przychodzi jako pull request. Na początku każdy pull request wymagał zatwierdzenia z konta
drugiego założyciela, więc agent, który napisał zmianę, nigdy jej nie zatwierdzał (to się zmieniło
23 października, patrz niżej). Testy są
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
([#302](https://github.com/ColdPhase/flux/pull/302)). Dlatego 7 października sami narysowaliśmy
finalny projekt, „Prostotę”: jeden spokojny język na komputerze i telefonie, jedna skrzynka
na to, co czeka na ciebie, i Kreska, narysowana linią buźka, która jest logo i ikoną każdego
agenta ([#336](https://github.com/ColdPhase/flux/issues/336)). Opis to nie projekt;
pokazujcie wyrenderowane ekrany wcześnie.

**Co zmieniło się po 7 października.**

- *Ograniczyliśmy przeglądy.* Dwaj agenci, którzy nawzajem się recenzują, mogą to robić bez końca.
  18 października ustaliliśmy, że pull request dostaje jeden pełny przegląd i jedno sprawdzenie
  poprawek, a blokadę, która się utrzymuje, odkłada się zamiast kręcić się w kółko
  ([komentarz w #249](https://github.com/ColdPhase/flux/issues/249#issuecomment-6247024855)). Tego samego
  dnia pozwoliliśmy jednemu agentowi przejmować bezczynne zadania drugiego i łączyć powiązane w jeden
  pull request ([komentarz](https://github.com/ColdPhase/flux/issues/249#issuecomment-6247887007)).
  23 października poszliśmy dalej: autor może sam scalić swój pull request, gdy przechodzą jego testy
  i nie ma otwartej poważnej uwagi z przeglądu, a recenzja kolegi może przyjść przed scaleniem albo po nim
  ([workflow, krok 5](../agents/workflow.md#5-review-fix-and-merge), [#656](https://github.com/ColdPhase/flux/pull/656)).
  Wybraliśmy szybkość zamiast drugiej pary oczu przed scaleniem.
- *Pierwszy zepsuł się nasz własny README.* 6 października pierwsze klonowanie na Macu trwało
  3 min 08 s przy pobraniu 206 MiB, głównie zrzutów ekranu z przeglądów w historii. Zarchiwizowaliśmy te
  materiały ([#428](https://github.com/ColdPhase/flux/pull/428), [#619](https://github.com/ColdPhase/flux/pull/619)),
  a README klonuje teraz płytko: 17 MB, co na maszynie z Linuksem w innej sieci zajęło 4 s
  ([czas do pierwszego uruchomienia](../development/time-to-first-run.md)).
- *Prawdziwy klient znajduje to, czego nie znajduje atrapa.* Idąc krok po kroku za własnym README
  z Claude Code, ktoś zauważył, że domyślnego połączenia nie da się zatwierdzić
  ([#320](https://github.com/ColdPhase/flux/issues/320)). 16 października Hubert zdecydował, że
  można przyznać mniej uprawnień, niż prosi klient ([#548](https://github.com/ColdPhase/flux/issues/548),
  scalone 17 października w [#571](https://github.com/ColdPhase/flux/pull/571)). 23 października to samo
  przejście z Codexem pokazało, że poprawka obejmowała tylko sposób, w jaki prosi Claude Code
  ([#660](https://github.com/ColdPhase/flux/issues/660)).
- *Wspólna edycja zajęła trzy kroki.* Ruch na mapie na żywo i wspólny tekst wiki pojawiły się
  14 października ([#389](https://github.com/ColdPhase/flux/pull/389)), nazwane kursory 17 października
  ([#585](https://github.com/ColdPhase/flux/pull/585)), a gotowa wersja 23 października
  ([#613](https://github.com/ColdPhase/flux/pull/613)).

**Co powiedzielibyśmy innemu zespołowi.** Warstwa koordynacji powinna być tak cienka, jak pozwala
GitHub. Recenzent powinien być niezależny od autora i podawać commit, który sprawdził (my trzymaliśmy
się tego przez prawie cztery tygodnie, a 23 października poluzowaliśmy to dla szybkości). Testujcie
prawdziwy stos i sprzątajcie po nim. Idźcie za własnym README z prawdziwym klientem, nie z atrapą.
Prowadźcie datowany dziennik tego, co poszło źle, bo z tej części inni uczą się najwięcej.

**Wypróbujcie.** Flux v0.1.0 jest już dostępny: [link]. Sklonujcie repozytorium, uruchomcie
`./flux up` i `./flux demo` i podłączcie własnego agenta przez MCP. Każdy z tych kroków jest w
[dzienniku budowy](https://github.com/ColdPhase/flux/blob/main/docs/build-log.md).
