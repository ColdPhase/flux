# Flux v8 — specyfikacja współdziałania materiałów

Status: implementacja interaktywna w lokalnym HTML. Dokument oddziela działające zachowania od wymaganej architektury produkcyjnej.

## 1. Problem do rozwiązania

v7 zachowywał część powiązań, lecz prezentował je jako podobne odnośniki „Dotyczy”. Użytkownik musiał odkrywać, dokąd link prowadzi, dlaczego znalazł się w tym miejscu i czy zdarzenie miało już skutek w innych widokach. Dodatkowo zadanie rozdzielało opis, komentarz, blokadę i wynik na kilka podobnych miejsc pisania.

v8 nie redukuje mapy, wiki i zadań do jednego rodzaju karty. Wprowadza wspólny sposób odczytu powiązań oraz jedną ścieżkę publikacji wiadomości o pracy.

## 2. Podstawowe obiekty zachowują odrębność

| Obiekt | Odpowiedzialność | Czego nie należy z nim utożsamiać |
|---|---|---|
| Wątek / wiadomość | Uczestnicy, wypowiedzi, odpowiedzi i historia | Dokument aktualnych ustaleń |
| Myśl / mapa / połączenie | Rozważane rozwiązania, pytania i przestrzenne relacje | Status wykonania pracy |
| Zadanie | Podjęte działanie, wykonawca, stan, terminy i wynik | Każdy pomysł na mapie |
| Strona / fragment wiki | Wersjonowana wiedza oraz wskazywany fragment | Kopia całej dyskusji |

Komentarze nie powstają w niezależnych bazach „komentarze wiki”, „komentarze mapy” i „komentarze tasków”. Wątki mają jawny przedmiot rozmowy; wiele widoków może wyświetlać ten sam identyfikator wątku.

Nie scala się wszystkich wątków powiązanych z zadaniem. Źródłowa dyskusja może pozostać osobną rozmową, a zadanie mieć własną późniejszą dyskusję. Interfejs zapewnia przejście między nimi.

## 3. Widoczny kontekst zamiast listy nieopisanych odnośników

Widok Rozmowy składa się z wyboru wątku, właściwej rozmowy i bocznego kontekstu. Na wąskich ekranach wybór wątku i materiały otwierają się jako panele, a nie dodatkowe ściśnięte kolumny.

Każdy podgląd materiału podaje jego typ, tytuł, nazwę miejsca nadrzędnego oraz przydatną treść. Zadanie pokazuje status i wykonawcę; fragment wiki pokazuje cytat; mapa pokazuje konkretne myśli.

Nagłówki wyjaśniają relację: „Praca omawiana tutaj”, „Pomysł rozrysowany na mapie”, „Wiki użyte w zadaniu”. Zwykłe wzmianki i sąsiedztwo na mapie są sekcjami wtórnymi. Kolor nie jest jedyną informacją o typie.

Pod dokładną wiadomością, z której utworzono myśl albo zadanie, pojawia się podgląd tego materiału. Mechanizm nie przykleja materiałów całego wielotematycznego wątku do każdej wypowiedzi.

## 4. Model relacji w nowej warstwie

`v8Graph(scope)` buduje indeks do odczytu z istniejących identyfikatorów. Nowe widoki używają `v8Context(key)` i tego samego systemu prezentacji materiałów.

| Relacja wewnętrzna | Przykład | Skutek |
|---|---|---|
| `produced` | Wiadomość → zadanie/myśl | Podgląd przy źródle i przejście wstecz |
| `discusses` | Wątek → zadanie/myśl/fragment/linia | Jedna rozmowa widoczna w kilku miejscach |
| `mentions` | Wiadomość/strona/opis → materiał | Odnośnik i odnośnik zwrotny, bez zmiany stanu |
| `works_on` | Zadanie → myśl | Praca widoczna w kontekście mapy |
| `uses` | Zadanie → dokument/fragment | Źródło widoczne przy pracy i na stronie wiki |
| `connected` | Myśl ↔ myśl | Bezpośredni sąsiad, nie automatyczna zależność zadań |
| `result` | Zadanie → wiadomość | Jeden aktualny wynik wyświetlany w wielu widokach |
| `blocker` | Zadanie → wiadomość | Powód blokady, pomoc, odblokowanie |
| `contains` / `shows` | Mapa → myśl; myśl → odniesienie | Przynależność lub jawnie pokazany materiał |

Ograniczony, wyjaśniony krok „rozmowa → zadanie → jego dokument” jest dozwolony. Nie wykonuje się nieograniczonego przechodzenia po całym grafie. Relacja A–B–C nie miesza komentarzy A i C. Zbieżność słów i tytułów nie jest podstawą automatycznego połączenia.

To model lokalny. W produkcji filtr uprawnień musi działać przed pobraniem materiałów i przed obliczeniem widocznych ścieżek. Samo filtrowanie HTML-u nie chroni danych.

## 5. Nawigacja bez utraty miejsca

Odnośnik do zadania lub wiki otwiera podgląd w panelu. Odnośnik do myśli ustawia właściwą mapę i zaznaczenie; przycisk powrotu pamięta źródłowy wątek. Powrót przywraca szkic.

Jeżeli otwarte zadanie dotyczy tej samej rozmowy, pole pisania jest przenoszone funkcjonalnie do panelu zadania. W środkowej kolumnie zostaje wskazanie, gdzie pisać. Nie pokazuje się dwóch konkurujących formularzy dla tego samego szkicu.

Zmiana stanu przez odpowiedź agenta nie kasuje szkicu i kursora. Rozmowa podąża za rosnącą odpowiedzią, gdy użytkownik jest na jej końcu. Czytanie wcześniejszych wiadomości nie jest przerywane skokiem na dół.

## 6. Publikacja pracy

Nowe wejścia korzystają z `v8Publish`. To nie trzy systemy komentarzy, lecz jeden zapis wiadomości z opcjonalnym skutkiem.

| Tryb | Operacja na wiadomości | Operacja na pracy |
|---|---|---|
| Wiadomość | Zwykła odpowiedź w wybranym wątku | Bez zmiany stanu |
| Przeszkoda | Ta wiadomość zostaje powodem blokady | Blokada, opcjonalne wskazanie pomocnika, lokalne powiadomienie |
| Wynik | Ta wiadomość zostaje bieżącym wynikiem | Wskaźnik wyniku, opcjonalne ukończenie, widoczność na mapie |

Przed wysłaniem wyświetla się krótki opis skutku. Po udanym wysłaniu tryb wraca do zwykłej wiadomości. Błąd walidacji nie czyści szkicu. Można oznaczyć istniejącą wypowiedź jako blokadę albo wynik bez kopiowania jej tekstu.

Blokada nie zmienia wykonawcy ani etapu na „Gotowe”. Odblokowanie zachowuje powód i historię. Próba zakończenia zadania z nierozwiązaną blokadą jest zatrzymywana.

Publikacja nowego wyniku zmienia wskaźnik, nie usuwa poprzedniej wypowiedzi. Mapa odczytuje wynik z wiadomości zadania. Nie powstaje automatycznie dodatkowa notatka wynikowa z oddzielnym tekstem. Starsze importowane notatki pozostają elementami historycznego modelu; nie ma pełnej migracji wszystkich możliwych przypadków.

Tytuł zadania wystarcza do utworzenia. Opis jest czytany jak treść, a nie stale otwarty formularz. Edycja jest świadomą akcją. Termin, osobisty plan i nakład zachowują niezależne znaczenia. Punkt powrotu jest osobisty, nie jest publicznym raportem ani blockerem.

## 7. Mapa i połączenia

Płótno zachowuje edycję, układ, przesuwanie oraz cofanie. Wygląd zwykłego połączenia nie zależy od sposobu jego utworzenia. Wybrana linia ma podgląd obu końców oraz możliwość skomentowania tej relacji.

Połączenie istniejących bloków dodaje sąsiedni kontekst; nie tworzy taska, nie scala dyskusji, nie zamienia tekstu w zależność wykonawczą. Myśl utworzona plusem nie dziedziczy całej historii zadań i komentarzy rodzica.

Przy wybranej myśli widać pracę, aktualny wynik, źródła wiki oraz sąsiadujące myśli. Rozmowy o samej myśli i rozmowy o pracy są odróżnione, lecz można do nich przejść bez wyszukiwania. Status „Gotowe” należy do zadania, a nie do zaakceptowania pomysłu.

Naprawiono również geometrię: panel boczny już zmniejsza płótno przez CSS, więc logika dopasowania nie odejmuje jego szerokości ponownie. Wcześniej prowadziło to do niepotrzebnie małej skali. Powiadomienie agenta nie zasłania przycisku powrotu.

## 8. Wiki jako źródło i wynik interpretacji

Strona pokazuje miejsca użycia w zadaniach, na mapach i w odwołaniach. Fragment można komentować, wskazać w rozmowie, dołączyć do zadania albo umieścić jako kartę odniesienia na mapie.

Wybór fragmentu do rozmowy trafia do widocznego szkicu bieżącego wątku. W v7→v8 zmienił się układ rozmów; stary mechanizm wskazywał niewidoczne pole ogólnego strumienia. W v8 naprawiono to zachowanie.

Fragment pamięta cytat, źródło, wersję i otoczenie tekstu. Otworzenie źródła zaznacza właściwe zdanie. Jeśli cytat przestał jednoznacznie pasować, podgląd pokazuje oryginał i ostrzeżenie. Nie ma milczącej zamiany historycznej wypowiedzi na treść nowej wersji wiki.

Aktualizacja wiki jest redakcją wiedzy, nie zmianą znaczenia wyniku testu. Wynik „kamera zawodzi po ciemku” nie jest równoznaczny z decyzją „wybieramy czujnik”.

## 9. Agent: mniej pozornej automatyki

Widoczność wyniku w kontekście mapy jest zachowaniem aplikacji, nie zadaniem LLM. Dlatego usunięto propozycję „dodać wynik do mapy”, kiedy właściwy wynik już tam jest dostępny.

Regułowy agent po wyniku może przygotować dopisanie obserwacji do jednego dokumentu jawnie używanego przez zadanie. Brak jednoznacznego dokumentu oznacza brak takiej automatycznej propozycji. Nie trzeba wpisywać `/ai` dla tego zdarzenia.

Propozycja jest wypowiedzią autora **Flux · agent AI · demo**. Wskazuje źródła. Zastosowanie weryfikuje stan strony oraz identyfikator i tekst wyniku, z którego powstała. Stary wynik nie może zostać dopisany jako bieżące ustalenie po jego zastąpieniu.

Ta implementacja nie rozumie treści jak model językowy. Nie przeprowadza semantycznej analizy dokumentu, nie czyta prywatnych repozytoriów i nie ma sesji Codex/Claude. MCP i konfiguracja dostawców nie są podłączone.

## 10. Zakres architektury

Nowa warstwa oblicza powiązania dla widoków i wspólną publikację pracy. Pozostaje nadpisaniem funkcji wcześniejszego prototypu, nie kompletnym refaktorem. Globalny stan, słuchacze starszych wersji, duży plik i obliczanie indeksu na żądanie nie są rekomendacją architektury produkcyjnej.

Przed wdrożeniem należy wydzielić model domenowy i komendy z UI, wprowadzić serwerowe ACL, idempotencję, wersjonowanie, transakcje, bezpieczne indeksy wyszukiwania oraz testy współbieżności. Mechanizm cytatów warto zastąpić trwałą identyfikacją bloków z kontrolą wersji. Odrębne grona projektów i DM muszą być egzekwowane także dla agentów i wyników wyszukiwania.

Nie zweryfikowano użyteczności w badaniu z zespołem. Ta wersja nie stanowi dowodu skuteczności dla ADHD ani kompletnej zgodności WCAG.

## 11. Podstawa wzorców dostępności

W3C opisuje rozpoznawalny cel linków na podstawie nazwy i kontekstu oraz konsekwentny wygląd podobnych funkcji. Są to inspiracje dla sposobu prezentacji materiałów, nie certyfikat tej implementacji.

- https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html
- https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p03-consistent-design/
