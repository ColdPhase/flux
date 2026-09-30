# Flux Studio 11 — system wizualny i interakcje

## Hierarchia

Sidebar: U mnie, szkicownik, projekty i DM. Nagłówek: miejsce, odbiorcy, mały zwijany cel, Razem, jeden panel agenta i ustawienia. Zakładki pracy oraz Co ważne są w stałym wierszu. Środek pozostaje rozmową, mapą, zadaniami lub wiki.

Nie ma dużego goal panelu ani dodatkowego return-strip. Przycisk Co ważne nie zamienia położenia z powrotem do źródła. Na małym ekranie ikony pomocnicze i skróty ustępują miejsca głównym działaniom; prywatny skrót przykrywa obszar pracy, nie ściska go do kilkudziesięciu pikseli.

## Cel

Zwijany, pojedynczy rezultat. Kryterium i powiązane zadania są opcjonalne. Zmiana kierunku ma historię, a ukończenie zadań nie udaje potwierdzonego efektu. Jest możliwość pozostawienia pustego celu, bez błędu lub obowiązkowego wdrożenia użytkownika.

## Podsumowanie

Prywatne, nad zapisanymi zmianami. Dwa zakresy, jedna akcja i jawne źródła. Generowanie nie przesuwa wiadomości do wspólnego czatu. Panel ma stabilny snapshot; nowe dane sygnalizowane przyciskiem. „Mam kontekst” nie znaczy „przeczytałem każdą wypowiedź”.

## Wiadomości i odnośniki

Ten sam bąbelek dla człowieka i AI. Bot ma robotyczną ikonę, podpis oraz oznaczenie demo. Propozycja jest materiałem w bąbelku, nie dodatkowym stylem całego autora. Cudze wiadomości są po lewej, własne po prawej.

Odnośnik jest częścią zdania: typ, ikona, nazwa. Materiał ma swój podgląd i semantykę. Zwykła wzmianka nie zmienia odbiorców i nie tworzy zadania. Kryterium prywatności musi być egzekwowane na serwerze w produkcyjnej wersji.

## Mapa i lista

Płótno: chwytanie, przesuwanie, plus, jedna ramka edycji i jedna podstawowa relacja. Automatyczne układanie jest jawne i odwracalne. Do rozmowy wskazuje dokładny kliknięty element.

Lista: drzewo prezentacyjne z liniami, wcięciami, przyciskami rozwijania. Dodatkowe krawędzie pokazane jako ↔. Nie wymusza się, aby graf był drzewem, i nie kopiuje się rekordów. Strzałki i zwykłe przyciski są dodatkowymi sposobami obsługi; nie deklaruje się niepełnego ARIA tree.

Wyszukiwanie map obejmuje bieżący projekt, a wybór przenosi do dokładnej myśli. Brak mutacji grafu przy szukaniu.

## Zadania

Karta: numer/tablica, tytuł, przeszkoda albo wynik, kontekst, wykonawca i daty/nakład, prywatny plan. Dłuższe teksty zawijają się i mają szczegóły po otwarciu. Kolumna zachowuje minimum ok. 264 px; przewija się tablica, nie cały layout.

Nakład przechowuje wartość z jednostką. Termin i osobisty plan mają inne kontrolki. Do stworzenia zadania wystarcza tytuł.

## Wiki i wyszukiwanie

Szukaj w wiki po tytule i treści; fragment wyniku jest widoczny przed otwarciem. Pierwsze dopasowanie można zobaczyć podświetlone. Lista jest dostępna również nad dokumentem na telefonie. Niezapisana edycja nie znika przez samo szukanie.

Globalna wyszukiwarka w sidebarze ma min-width:0, skracany tekst i chowającą się pomoc skrótu. Ctrl/Cmd K pozostaje dostępne, ale nie wymagane.

## Stałe palety

`mint | iris | amber | teal | sky | copper | rose | lime | slate`

Dziewięć akcentów, każdy w wariancie light/dark; 18 zestawów. Mięta zachowana, pozostałe zestrojone do neutralnego tła. Brak własnych kolorów, HEX, akcentów organizacji i runtime theme buildera.

Źródło prawdy: statyczne `paletteDefs()` oraz `src/refinement.css`. Nowa paleta wymaga zmiany kodu, dodania obu wariantów i testu kontrastu.

Podstawowe tokeny: `--bg`, `--surface`, `--elevated`, `--text`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--on-accent`, `--own`. Barwy semantyczne przeszkód/wyników nie zmieniają znaczenia po zmianie akcentu. Każdy stan ma również tekst i ikonę.

## Typografia i ruch

Systemowy font stack, bez pobierania plików fontów. Wielkości bazują na dotychczasowym interfejsie, bez poszerzania sidebaru pod krótkie skróty. Delikatne obrysy, ograniczone animacje, szacunek dla prefers-reduced-motion. Focus nie jest usuwany globalnie dla ukrycia podwójnej ramki.

## Testy i granice

108 par kolorów przekroczyło 4,5:1 w wybranych kombinacjach. Nie jest to pełny audyt WCAG. Zrzuty i testy layoutu obejmują wybrane szerokości, a nie wszystkie urządzenia i powiększenia. Potrzebne są dalsze testy czytników, dużego tekstu i użytkowników bez instrukcji.
