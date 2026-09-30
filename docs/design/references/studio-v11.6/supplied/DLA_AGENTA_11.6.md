# Flux Studio 11.6 — opis zmian i kontrakt wdrożenia

Dokument do przekazania agentowi rozwijającemu właściwą aplikację. Punkt odniesienia: działający prototyp `flux-studio-v11.6.html`, zmiany względem 11.5. Data: 30 września 2026.

**Status:** poniższe zachowania są zaimplementowane lokalnie w HTML. Sesje agentów, PR-y, CI i wyniki review są demonstracyjne. Transport MCP, GitHub App, model LLM, serwerowe konta, autoryzacja i współbieżne transakcje pozostają do wdrożenia. Nie traktuj sprawdzeń JavaScript w przeglądarce jako ochrony serwera.

## 1. Nienaruszalne zasady produktu

Flux jest źródłem prawdy dla zadań, rozmowy, wyników, celów i wiki. Zakładka Agenci pokazuje pracę na tych samych rekordach; nie tworzy drugiego backlogu, osobnego czatu ani kopii wiedzy. GitHub dostarcza kod, commity, PR-y i CI. **Nie tworzymy GitHub Issues ani ich synchronizacji z zadaniami Fluxa.**

Projekt/workspace jest granicą odbiorców, połączeń i repozytoriów. Agent Huberta jest agentem Huberta; agent Marka jest agentem Marka. Wskazanie cudzego wykonawcy to prośba o zgodę właściciela, nie prawo do użycia jego konta/subskrypcji. Wbudowany pomocnik Fluxa pozostaje osobną, dotychczasową funkcją. Zewnętrzni wykonawcy działają lokalnie u właścicieli i korzystają z Fluxa przez MCP; ta zmiana nie wymaga budowania dla nich terminala, kontenera lub przeglądarki w serwerze Fluxa.

Zachowujemy istniejącą typografię bezszeryfową, trzy akcenty z wariantami light/dark, szkice, odnośniki, historię, natywne zadania i operacje. Zmiana wizualna jest ograniczona do opisanych miejsc.

## 2. Zadanie powstało ≠ rozpoczęła się rozmowa

### 2.1. Utworzenie zadania

Każde nowe zadanie utworzone przez zwykłą operację domenową publikuje jeden kompaktowy wpis w rozmowie swojego projektu:

> Nowe zadanie · Hubert  
> Sprawdzić ponowne połączenie →

To informacja o zdarzeniu, nie wielka karta, osobny task ani komentarz człowieka. Tytuł jest żywym odnośnikiem do dokładnego ID. Kliknięcie otwiera istniejące zadanie. Utworzenie z mapy lub wiadomości zachowuje swoje źródła. Anulowany formularz, samo otwarcie zadania, render, ponowne wczytanie i import nie publikują nowych ogłoszeń.

Lokalny kształt rekordu:

```js
messages[noticeId] = {
  id: noticeId,
  space: task.space,
  author: creatorId,
  text: '',
  primary: `task:${task.id}`,
  systemEvent: 'task.created',
  taskTitleAtCreation: task.title,
  parent: null,
  at: createdAt,
  version: 1,
  files: []
};
task.createdMessage = noticeId;
```

**`createdMessage` nie jest `task.anchor`.** Ogłoszenie nie przejmuje roli korzenia rozmowy. Nie nadpisuj go potem treścią pierwszego komentarza i nie przypisuj pierwszej wypowiedzi autorowi utworzenia zadania.

W produkcji zapis taska i zdarzenia ma być jedną transakcją. Dla ponowionego polecenia potrzebny jest klucz idempotencji; lokalny generator losowych ID nie zapewnia sam idempotencji sieciowej. Import zachowuje dawne zdarzenie, ale go nie emituje ponownie.

### 2.2. Pierwsza rzeczywista wiadomość

Pierwsza wypowiedź przy zadaniu ma być widoczna bez rozwijania odpowiedzi w rozmowie projektu:

```text
Nowe zadanie · Hubert
Sprawdzić ponowne połączenie

Marek
Sprawdzę, czy po odłączeniu USB nie wracają stare komendy.
[Zadanie: Sprawdzić ponowne połączenie]
  2 odpowiedzi
```

Pierwsza wiadomość otrzymuje `parent: null`, `primary: task:<id>` i staje się kotwicą tego zadania. Każda następna wypowiedź jest odpowiedzią do jej ID, niezależnie od tego, czy została wysłana z zadania, zakładki Agenci, czy istniejącego wątku w rozmowie. Nadal istnieje jedna warstwa odpowiedzi.

Lokalna implementacja zachowuje interfejs `ensureAnchor()`: pusty techniczny placeholder utworzony wewnątrz transakcji jest wypełniany przez `createMessage()`. Zachowuje ID, ale dostaje prawdziwego autora, czas, tekst i pliki. Nie pozostają osobna pusta karta i ukryty pierwszy komentarz. Wypełnienie dotyczy wyłącznie pustej kotwicy zadania bez plików, propozycji, zdarzenia systemowego i odpowiedzi.

Pierwszą wiadomością może być tekst, załącznik, przeszkoda, wynik albo polecenie AI. Załącznik bez tekstu jest pełnoprawnym korzeniem i jest widoczny także w panelu zadania. Zapis efektu odwołuje się do tego samego ID wiadomości. Przekazanie pracy przez użytkownika również jest rzeczywistym wpisem w rozmowie zadania, więc może ją rozpocząć.

Istniejące wątki z treścią i odpowiedziami nie są przepisywane podczas migracji. Dawna pusta karta z odpowiedziami również zachowuje historię. Nie rekonstruuj dat, autorstwa ani nie twórz retrospektywnych ogłoszeń dla starych zadań. Ewentualna migracja historycznych wątków wymaga osobnej, jawnej decyzji.

W produkcji równoczesne pierwsze komentarze trzeba serializować: blokada/unikalność kotwicy zadania i atomowe rozstrzygnięcie „utwórz korzeń albo odpowiedz”. Nie wystarczy sprawdzenie `anchor === null` w kliencie.

### 2.3. Błędy zapisu i cofanie

Po odmowie zapisu wycofujemy zmianę taska, wiadomości, kotwicy, efektów i powiadomień. Szkic, załączniki i wskazane materiały zostają do ponowienia. Formularz tworzenia nie powinien zamykać się z komunikatem sukcesu po nieudanym zapisie.

Bezpieczne cofnięcie nieużywanego zadania utworzonego z propozycji AI pozostawia ślad `task.creation_reverted`, z historycznym tytułem i bez martwego `primary`. To nie kasowanie cudzej późniejszej rozmowy.

## 3. Mapa, kanban i wiki

### Mapa

Pod myślą pozostaje wyłącznie licznik `1 zadanie`, `2 zadania`, `5 zadań`. Usunięto inline tytuły dwóch pierwszych zadań, przycisk pozostałych tytułów i podglądy wyników zajmujące powierzchnię płótna. Licznik otwiera istniejący wybór wszystkich powiązań ze stanami i osobami. Wybór działa po dokładnym ID, nie po indeksie pierwszego zadania. Powrót „Zadania tej myśli” i pozycja kamery pozostają. Lista gałęzi korzysta z tego samego wyboru. Nie usuwać relacji z danych ani zamieniać węzłów w kanban.

### Kanban

Przeciąganie podświetla tylko `.column-cards`, czyli obszar listy kart. Nagłówek „W trakcie”, licznik i „Dodaj zadanie” pozostają neutralne. Zachowano możliwość upuszczenia na nagłówku kolumny; wciąż podświetla się jedynie jej lista. Pusta kolumna ma niewielki, widoczny cel. Podświetlenie znika przy wyjściu, upuszczeniu i anulowaniu. Upuszczenie poza kolumną nic nie zmienia. Nieudana zmiana na „Zrobione” przy aktywnej przeszkodzie zachowuje stan zadania. Kolejność kart nie jest nową funkcją tej iteracji — drag zmienia etap.

### Wiki

Aktywna strona po lewej ma słabe neutralne tło, lekko mocniejszy tekst i mały punkt, bez podwójnej kolorowej kreski. Ustawione jest `aria-current="page"`; widoczny focus klawiatury pozostaje. Edytor dokumentowy/Markdown, historia i szkice są zachowane.

## 4. Agenci: wykonawca i recenzent to dwie niezależne role

Przycisk **Agenci → Przekaż zadanie** otwiera „Kto wykonuje, kto sprawdza?”. Formularz zawiera istniejące zadanie, wykonawcę, recenzenta, opcjonalną wskazówkę oraz osobną zgodę na zmianę człowieka odpowiedzialnego za task.

Wykonawcą może być dowolne aktywne połączenie tego projektu: własne lub należące do Marka. Wyłączone połączenia są opisane i niedostępne do nowego przydziału; offline nie oznacza automatycznego uruchomienia sesji. Recenzent musi należeć do **innego właściciela** niż wykonawca. Można wybrać go później. Przycisk pomiędzy listami zamienia role, nie przełącza zalogowanego profilu.

Przykład:

```text
Wykonuje: Claude Code · Marek
Sprawdza: Codex · Hubert
→ Poproś o wykonanie
→ Marek: Przyjmij / Odmów
→ lokalna sesja Marka podejmuje pracę
→ wynik lub PR
→ review przez Codexa Huberta
→ odbiór przez człowieka
```

Wybierając własnego agenta do review, użytkownik świadomie zgadza się na review tej pracy. To nie globalna reguła i nie zgoda na przyszłe zadania. Jeśli użytkownik wskazuje cudzego recenzenta, potrzebna jest istniejąca reguła właściciela dla tego zadania albo osobne zatwierdzenie review.

### 4.1. Zgoda na wykonanie

Cudzy wykonawca tworzy stan `awaiting_execution`, `executionApproved: false`. Tylko właściciel połączenia widzi i może wykonać przyjęcie/odmowę. Zatwierdzenie daje `queued` — nie twierdzi jeszcze, że lokalny proces pracuje. W prototypie następny „Krok” pokazuje podjęcie pracy. W produkcji wymaga to potwierdzenia autoryzowanej sesji MCP.

Odmowa początkowej prośby zamyka wykonanie jako `cancelled`, ale nie usuwa ani nie kończy taska. Własny wykonawca dostaje `queued` po jawnym zleceniu. Połączenie niedostępne nie jest zastępowane cudzym agentem.

Checkbox „Przypisz też zadanie: Marek” oznacza odrębny skutek na `task.assignee`. Domyślnie nie jest zaznaczony. Przy cudzym agencie przypisanie człowieka następuje dopiero po zgodzie właściciela. Sam agent wykonujący nie musi być właścicielem ludzkiej odpowiedzialności za task.

### 4.2. Zakres zgody na review

Zachowane są trzy możliwości: reguła `autoReview` ograniczona do `grantTasks`, jednorazowe zatwierdzenie konkretnego przedmiotu oceny, albo jawny wybór własnego recenzenta dla danego wykonania i jego generacji przydziału.

Aktualny przedmiot ma postać:

```text
commit:<headSha>
message:<outputMessageId>:<version>
```

Nie traktuj pozwolenia na uruchomienie kolejnego review jako już wystawionej pozytywnej oceny. Zmiana SHA albo wersji wyniku zawsze unieważnia ocenę. Reguła właściciela może pozwalać wykonać nową ocenę bez kolejnego pytania, ale nie przenosi starego werdyktu na nową treść.

Zmiana recenzenta czyści poprzednią ocenę i zgody związane z poprzednią rolą. Wskazanie tego samego recenzenta nie tworzy kolejnego identycznego przekazania. Podgląd i przyciski nie zastępują weryfikacji właściciela i projektu przy każdej operacji serwera.

## 5. Punkt przekazania i kontynuacja pracy

Przy rozmowie zadania jest mały wiersz „Wykonuje → Sprawdza” oraz **Punkt przekazania**. Panel odczytuje aktualny opis zadania, ostatnią zapisaną aktualizację agenta, aktualny stan oczekiwania i odnośniki do materiałów Fluxa. Oferuje otwarcie wiadomości źródłowej i pobranie pakietu odniesień.

Nie wywołuje modelu do generowania streszczenia, nie zapisuje nowej strony wiki i nie kopiuje całego czatu. Pakiet kontekstu obejmuje ID, wersje/odciski źródeł i dane przydziału; pełne materiały agent pobiera, gdy ich potrzebuje. Nie oznacza to zmierzonej oszczędności tokenów ani gwarantowanego budżetu lokalnego klienta.

**Przekaż dalej** jest dostępne dla właściciela aktualnego wykonawcy przed utworzeniem PR-u lub wyniku. Nowa osoba ma otrzymać tę samą pracę, a nie jej duplikat:

- zachowaj `taskId` i `runId`;
- zwiększ `generation`, zatrzymaj dotychczasowy przydział;
- wyślij jedną wiadomość przekazania przy oryginalnym zadaniu;
- poproś nowego właściciela o zgodę;
- po odmowie przywróć poprzedni przydział w stanie **paused**, bez cichego wznowienia.

Po utworzeniu artefaktu nie przepinamy jego autora na innego agenta. Można dokończyć lub zmienić review, a role odwrócić w następnej pracy. W produkcji `generation` powinno pełnić funkcję fencing tokenu: spóźniony wynik dawnego wykonawcy nie może zostać przyjęty jako efekt nowego przydziału. Samo cofnięcie uprawnień Flux MCP nie zatrzyma niezależnej lokalnej komendy Git użytkownika.

## 6. Review kodu oraz zwykłego wyniku

### Praca z PR-em

Zachowany przepływ: wykonanie → PR → prośba o review → ewentualna zgoda właściciela → review → uwagi → nowy commit → aktualne CI → ponowne review → człowiek. Werdykt przypięty jest do `headSha`. Scalenie wymaga aktualnych checków i oceny w scenariuszu. Scalenie nie kończy zadania ani nie potwierdza pracy fizycznego urządzenia.

### Praca bez PR-u — nowość

Gdy zadanie nie ma podłączonego repo, wykonawca zapisuje wynik jako wiadomość Fluxa. `outputMessage` wskazuje jej ID, a `outputVersion` wersję przekazaną do sprawdzenia. Wybrany recenzent otrzymuje prośbę o ocenę tej wiadomości wobec zadania i źródeł. Nie tworzymy PR-u tylko po to, żeby przeprowadzić review.

```text
running
→ waiting_review
→ awaiting_owner (tylko gdy brakuje zgody)
→ reviewing
→ needs_user
→ completed (po potwierdzeniu efektu przez człowieka)
```

Bez wybranego recenzenta wynik trafia do człowieka; UI nie udaje przeprowadzonej kontroli. Po edycji sprawdzanej wiadomości `reviewedOutputVersion` przestaje być aktualna i odbiór jest blokowany do ponownej oceny. Przycisk **Ponów review wyniku** nie może wielokrotnie tworzyć tej samej aktualnej prośby. Zmianę wersji trzeba sprawdzić również przy zapisie formularza odbioru, nie tylko przy jego otwieraniu.

W HTML review ma przewidywalny, oznaczony przebieg demo. Nie traktuj tekstu „sprawdzono” w seedzie/demo jako rzeczywistej analizy LLM, testów ani dowodu jakości.

## 7. Zmienione dane lokalne

Nie zmieniono głównego schematu `11` ani schematu `coop: 1`; rozszerzenia są opcjonalnymi polami istniejących rekordów:

| Rekord | Pola / znaczenie |
|---|---|
| `tasks` | `createdMessage` — informacja o utworzeniu, osobno od `anchor` i `result` |
| `messages` | `systemEvent`, `taskTitleAtCreation`; pierwsza wypowiedź jako prawdziwy korzeń |
| `agentRuns` rodzaju `coop` | `generation`, `requestedBy`, `executionApproved`, `assignPerson`, `instructionMessage` |
| `agentRuns` — review | `reviewApprovedConnection`, `reviewApprovedBy`, `reviewApprovedGeneration`, `approvedReviewToken`; zachowane `approvedReviewSha` |
| `agentRuns` — wynik bez PR | `outputMessage`, `outputVersion`, `outputReview`, `reviewedOutputVersion` |
| `agentRuns` — przekazanie | `previousAssignment` jako stan odzyskania przed decyzją nowego właściciela |
| `coop.deliveries` | wskazanie oryginalnej wiadomości, odbiorcy i wykonania; `kind: execution/review`, generacja lub wersja źródła |

Instrukcja użytkownika jest treścią jednej wiadomości, nie drugim opisem taska. Delivery to techniczne doręczenie referencji, nie drugi magazyn rozmów. Nowe pola źródłowe muszą wskazywać materiały tego samego projektu. W imporcie projektu i przy odtworzeniu backupu zgody wykonania/review są usuwane, połączenia nie są aktywowane. Archiwum pozostaje niewykonywalną historią.

## 8. Ruch i czytelność stanu

Aktywna praca i review mają małą sferę punktów Canvas oraz delikatną linię aktywności. Bieżący etap może mieć subtelny puls. Wskaźnik nie zmienia etapu sam i nie podaje fikcyjnego procentu. Nazwa agenta, właściciel i opis rzeczywistego stanu pozostają obok.

Animacja zatrzymuje się przy `prefers-reduced-motion`, ukrytej karcie, poza widocznym obszarem i za modalem. Przy zgodzie, CI, offline i oczekiwaniu na człowieka stan jest statyczny. Na małym ekranie animacja nie powinna wypychać pola odpowiedzi. Inspiracje wskazane przez użytkownika: AI Chat, AI Task List i Thinking Orbs z 21st.dev; kod animacji w tej paczce jest lokalną implementacją, bez pobierania tych komponentów.

## 9. Mapa kodu

| Plik | Odpowiedzialność zmian |
|---|---|
| `src/app.js` | tworzenie taska i ogłoszenia, pierwsza wiadomość, rollback, drag/drop |
| `src/experience.js` | ślad cofnięcia automatycznie utworzonego zadania |
| `src/polish.js` | tylko licznik zamiast tytułów zadań na mapie |
| `src/coop.js` | role, zgody, przekazanie, review wyników, pakiet kontekstu, eksport/import |
| `src/coop-orb.js` | mała aktywna sfera, kontrola życia animacji |
| `src/flow.js` | projekcje ogłoszenia, pierwszego komentarza, subtelne stany i wersja |
| `src/flow.css` | obszar drop, licznik, wiki, role, animacja i mobile |
| `tests/test_flow116.py` | nowe kontrakty i scenariusze brzegowe |

To nadal iteracyjny prototyp z warstwami adapterów. W docelowej implementacji przenieś reguły do wspólnego serwisu domenowego używanego przez UI, MCP i wbudowane AI. Nie kopiuj bezrefleksyjnie układu globalnych zmiennych i nadpisywania funkcji do produkcji.

## 10. Scenariusze odbioru dla właściwej aplikacji

1. Utwórz task z kanbanu, mapy i propozycji. Za każdym razem dokładnie jedno ogłoszenie w odpowiednim projekcie, bez dodatkowego taska. Anulowanie i odczyt nie publikują niczego.
2. Pierwszy komentarz ma treść w strumieniu i `parent:null`; drugi/trzeci wskazują ten sam root. Pierwszy autor może różnić się od autora taska. Powtórz dla załącznika, przeszkody i wyniku.
3. Zasymuluj odmowę zapisu. Nie ma połowy operacji; treść i pliki można wysłać ponownie. Nie ma fałszywego komunikatu sukcesu.
4. Myśl z trzema zadaniami pokazuje tylko licznik. Każde z trzech ID da się otworzyć i wrócić bez przestawiania kamery.
5. Podczas drag podświetla się tylko lista docelowej kolumny. Nagłówek pozostaje neutralny, ale upuszczenie na nim zachowuje działanie. Escape/anulowanie nie pozostawia koloru.
6. Hubert wybiera Claude Marka jako wykonawcę i własnego Codexa do review. Nie powstaje duplikat taska. Przed zgodą Marka nie ma wykonania ani zmiany assignee.
7. Hubert nie może ukrytym wywołaniem zatwierdzić prośby za Marka. Odebranie dostępu do projektu musi być sprawdzone ponownie po stronie serwera.
8. Marek przyjmuje → queued; lokalna sesja dopiero potem zgłasza started. Offline nie uruchamia zastępczego klienta i nie wygląda jak „myślenie”.
9. Włącz zmianę osoby odpowiedzialnej, sprawdź jej moment po zgodzie. Bez checkboxa assignee zostaje bez zmian.
10. Przekaż niedokończoną pracę dalej; nowa generacja, te same task/run. Odmowa przywraca starego wykonawcę jako paused. Spóźniony wynik poprzedniej generacji nie może wejść do bieżącej pracy.
11. Przy PR nowe SHA usuwa ważność oceny. Przy wyniku wiadomości nowa wersja blokuje odbiór aż do ponownego review. Nie generuj fikcyjnego PR dla pracy bez repo.
12. Import zachowuje historię i referencje, ale nie zgody ani żywe sesje; nie publikuje kolejnych ogłoszeń. Drugi workspace nie widzi połączeń i kontekstu pierwszego.
13. Animacje stop przy ograniczeniu ruchu/ukryciu/modalach; nowe aktualizacje nie przewijają osoby czytającej wcześniejszą historię; szkic jest wspólny między widokami tego samego taska.

Wersja HTML dostarcza testowalny kontrakt UI i lokalnych skutków. Wdrożenie sieciowe wymaga dodatkowo idempotencji, transakcji, kontroli równoczesności, autoryzowanych zdarzeń sesji i rzeczywistej weryfikacji wyników. MCP nie budzi automatycznie dowolnego zamkniętego klienta, a statyczny HTML nie pracuje po zamknięciu.
