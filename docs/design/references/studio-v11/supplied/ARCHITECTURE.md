# Flux Studio 11 — architektura lokalnego prototypu i granica produkcyjna

## Status

Jednoplikowy frontend z jawnym stanem, operacjami i renderowaniem. Nie ma backendu, wieloużytkownikowej bazy, autoryzacji serwerowej, rzeczywistego LLM ani transportu audio/video. Warstwa `refinement.js` rozwija i zastępuje wybrane funkcje v10. Jest to testowalny prototyp produktu, nie gotowy framework produkcyjny.

`src/build.py` składa `app.js` z `experience.js` i `refinement.js` w jeden zakres, dodaje trzy arkusze oraz szablon. Plik wynikowy nie wymaga CDN. Systemowe fonty nie są dostarczane jako osobne pliki.

## Główne rekordy

- `users`, `spaces`: nazwana osoba i niezależne grono/projekt/DM.
- `messages`: treść, autor, czas, rodzic odpowiedzi, materiały i oznaczenia. Odpowiedzi mają jedną warstwę.
- `maps`, `nodes`, `edges`: graf myślenia, nie statusy pracy.
- `boards`, `tasks`: wykonanie, opis, osoba, daty, oszacowanie, źródła, przeszkody i wynik.
- `pages`, `fragments`: wersjonowana wiedza i cytaty z otoczeniem/wersją.
- `anchors`: powiązanie materiału z jego rzeczywistą kartą rozmowy. Nie jest równoznaczne z każdą wzmianką o materiale.
- `effects`: konkretna przeszkoda/rozwiązanie powiązane z wiadomością i zadaniem.
- `attachments`: lokalnie zapisane załączniki dopuszczonych formatów.
- `activity`, `audit`: obserwowalne zmiany i zapisane operacje.
- `agentRuns`, `proposals`: stany wykonań i kontrolowane zmiany.
- `sessionsArchive`: zapisane skutki sesji, bez nagrania audio.
- `prefs`: dane osobiste: motyw, szkice, odczyt, plan, punkt powrotu, wizyty i prywatne skróty.

## Tożsamość i typy relacji

Odnośnik ma typ i ID. `node:x` jest czymś innym niż `task:x`. Tekst wiadomości ma tokeny referencji, a UI renderuje je jako opisane odnośniki. Import przepina także tokeny.

„Powstało z wypowiedzi”, „ma własną rozmowę”, „tylko wspomniano”, „połączone na mapie” i „blokuje zadanie” pozostają różnymi relacjami. Rozszerzalność nie może ich sprowadzić do jednego dowolnego linku.

Kliknięcie plusa na mapie oraz połączenie istniejących elementów tworzy zwykłą relację. `outlineParent` zapamiętuje kierunek prezentacji listy dla dopisanej myśli; nie nadaje nowej semantyki krawędzi. Lista buduje las rozpinający i pokazuje pozostałe krawędzie jako odnośniki boczne. Nie usuwa cykli z danych.

Przy udostępnieniu myśli przekazywany jest jej bezpośredni identyfikator. Nie bierze się celu ze starego panelu, rodzica ani pierwszego źródła. Jeśli istniejąca karta nie ma dokładnie tej myśli jako `primary`, przygotowuje się nowy szkic publikacji.

## Operacje i skutki

Wiadomość zwykła → treść rozmowy.

Wiadomość jako przeszkoda → jawny powód blokady i źródło prośby; wykonawca się nie zmienia.

Rozwiązanie → zamknięcie wskazanej przeszkody, nie wszystkich i nie całego zadania.

Wynik → wskaźnik na jedną wiadomość. Zadanie i mapa odczytują aktualne źródło zamiast utrzymywać kopie tekstu.

Wiki → odrębna wersja wiedzy. Dopisanie obserwacji jest świadomą zmianą, nie automatyczną interpretacją testu jako decyzji.

Cel projektu → osobne kryterium i wskazanie istniejącej pracy. Progress nie jest potwierdzeniem rezultatu. Historyczny kierunek pozostaje zapisany.

## Wizyty i prywatny catch-up

`prefs[user].visits[space] = {at, through}` rejestruje ostatni znany moment widocznej pracy. Przy wejściu UI zachowuje kopię poprzedniej wizyty jako bazę. Aktualizacje co 15 sekund, opuszczenie miejsca i zdarzenia widoczności minimalizują utratę punktu powrotu; nie są dokładną telemetrią przeczytania.

`prefs[user].review[space]` to jawnie obejrzany zakres. `read` dotyczy wiadomości. Te stany nie są scalane.

Panel przechwytuje `baselineAt`, górny czas i sekwencję aktywności. Źródła otwiera w bieżącej aplikacji, a powrót zachowuje snapshot. Nowe wiadomości nie przestawiają otwartego podsumowania, tylko sygnalizują odświeżenie.

`buildPrivateBrief()` jest ekstraktorem demonstracyjnym. Pracuje tylko na projekcie i przedziale, opcjonalnie filtrując osobisty zakres. Wyjście trafia do `prefs.privateBriefs`, a nie `messages`, `agentRuns`, powiadomień lub wspólnego audytu. Token żądania i tożsamość unieważniają spóźnione wyniki po zmianie zakresu/profilu.

Docelowy LLM powinien zachować taką samą granicę odbiorcy. Jego prywatny wynik nie może być publikowany w projekcie przez wspólny event handler. Nie ma potrzeby nadawać mu stałego dostępu do prywatnych DM tylko dlatego, że użytkownik ma tam konto.

## Agent projektu

Polecenie `/ai` w rozmowie tworzy wiadomość człowieka i odpowiedź robota. Zdarzenie wyniku może przygotować propozycję wiki przy jednoznacznym celu. Propozycja ma źródła i ich wersje; zmiana źródła unieważnia stare zastosowanie. Anulowanie, zastosowanie, bezpieczne cofnięcie i ochrona przed powtórzeniem są jawne.

Zwykła wiadomość robota korzysta ze wspólnego komponentu. Tożsamość AI wynika z autora i ikony. Nie ma dwóch niezależnych czatów w zależności od tego, kto odpowiedział.

Lokalny agent nie jest usługą LLM. Prawdziwy wykonawca wymaga kolejki, kosztów, modelu, uprawnień, limitów i serwerowego życia niezależnego od karty. MCP jest interfejsem do operacji, a nie tą kolejką.

## Live

Sesja pamięta projekt, uczestników i źródłowy materiał. Zmiana zakładki jej nie kończy. Pokazanie fragmentu jest oddzielnym komunikatem o obiektach; nie oznacza przechwytywania pulpitu.

Dołączenie i podążanie są jawne. Wyjście oraz cisza zatrzymują lokalne urządzenia. Spóźniony wynik systemowej zgody jest unieważniany, aby nie wznowić mikrofonu po wyjściu. Strumienie nie trafiają do JSON-u.

Wydanie nie zawiera zdalnego SFU/TURN, sygnalizacji ani realnych uczestników. Uprawnienia materiału i mediów muszą być w produkcji sprawdzane osobno. Przetwarzanie audio przez AI wymaga jawnego odbiorcy, zgody i modelu retencji.

## Szukanie i układ

Lokalne wyszukiwanie jest filtrem danych w dozwolonym projekcie. Nie buduje globalnego indeksu z materiałami niedostępnymi użytkownikowi. Zadania: tytuł/opis/stan źródeł/osoby; mapy: nazwy i treść węzłów; wiki: obecny Markdown. Zapytanie nie edytuje źródła.

Kanban ma elastyczny układ z minimalną czytelną szerokością kolumn. Scroll jest w jego kontenerze. Widok listy nie jest nowym magazynem danych mapy. Stałe ID pozwalają zachować te same źródła przy przełączaniu.

## Archiwum

Eksport projektu wybiera jedno miejsce oraz jego materiały. Autorzy są historycznymi profilami. Nie bierze całego `prefs`. Import waliduje i remapuje wszystkie ID przed publikacją nowego projektu; stary stan pozostaje do wycofania przy błędzie zapisu. Nie uruchamia dawnych propozycji i sesji.

Pełne odtworzenie jest osobną operacją zastępującą całą bazę. Schematy 09/10/11 są jawnie rozpoznawane. Szczegóły: [IMPORT_EXPORT.md](IMPORT_EXPORT.md).

## Co wymaga innego rozwiązania produkcyjnego

Serwerowe konta i SSO, ACL dla każdego endpointu/załącznika/indeksu, transakcje, bezpieczne przechowywanie sekretów, współbieżna edycja, CRDT lub inny świadomy model współpracy, idempotencja integracji, podpisane webhooki, E2EE tam gdzie obiecane, trwałe kolejki, retencja, szyfrowane backupy, zarządzanie tożsamością importowanych autorów i audyt operacji.

Rozszerzenia powinny używać tych samych działań i powiązań. Nie wolno dawać dowolnemu pluginowi pełnego dostępu do bazy i nazywać deklaracji uprawnień sandboxem. SDK, runtime i marketplace pozostają kierunkiem, nie funkcją tego pliku.
