# Flux Studio 11 — audyt implementacji i zakres testów

## Wykonane

169 automatycznych scenariuszy w rzeczywistym DOM Chromium: 65 podstawowych, 45 z zakresu powrotu/AI/Live, 59 nowych. Oddzielnie 108 wybranych par kontrastu dla dziewięciu akcentów na dwóch tłach. Raporty i skrypty w `tests/`.

Sprawdzono m.in. brak publikacji prywatnego skrótu, oba zakresy, prawdziwy punkt wizyty, pierwsze wejście, zmianę profilu/zakresu w trakcie generowania, szkice, stałą geometrię przycisku, cel i potwierdzenie efektu, nakłady dni/tygodni, wyszukiwanie w trzech widokach, dokładne udostępnienie dziecka, listę grafu z cyklem i połączeniem bocznym, wspólny styl wiadomości AI, walidację importu i nowe ID, autorstwo, brak prywatnych danych w eksporcie projektu, duplikaty, prototypy obiektów, błąd historii, wycofanie po odmowie zapisu oraz rzeczywiste pobranie i wgranie pliku przez browser API.

Istniejące testy zostały aktualizowane tylko dla zmienionych kontraktów: schematu 11, wyboru formatu eksportu, nowego edytora nakładu, liczby palet, listy i stałego przycisku powrotu. Ich przejście nie oznacza automatycznie pełnej regresji wszystkich dawnych wersji.

## Poprawione błędy

- Dziecko mapy przejmowało cel starego panelu rodzica. Zmiana zaznaczenia i dodanie dziecka unieważniają ten panel, a udostępnienie korzysta z dokładnego ID.
- Prywatna prośba o skrót korzystała ze wspólnej ścieżki AI. Nowa ścieżka nie zapisuje wiadomości, powiadomień ani publicznych wykonań.
- „Powrót po tygodniu” był demonstracyjnym punktem startu. Obecna normalna ścieżka ma własny rekord wizyty każdego projektu/osoby.
- Co ważne zmieniało położenie z przyciskiem powrotu. Nowy nagłówek ma stały układ i jedno wejście do tego widoku.
- Orientacyjny nakład miał tylko kilka krótkich presetów. Nowy formularz zachowuje jednostkę również w panelu szczegółów.
- Brak lokalnych wyszukiwarek oraz ukryta lista wiki na telefonie.
- Płaska mapa w liście i brak widocznych relacji. Nowa lista pokazuje las oraz dodatkowe krawędzie.
- Kanban zgniatał karty. Nowy ma minimalną szerokość i własny scroll.
- Wiadomości AI miały dodatkowe style. Zwykły bąbelek dziedziczy styl wspólnego komponentu.
- Eksport JSON oznaczał zawsze pełną bazę z prywatnymi danymi. Wydzielono prawdziwy eksport projektu oraz wyraźny backup całej aplikacji.

## Środowisko

Próba nawigacji `file://` została zablokowana przez politykę środowiska (`ERR_BLOCKED_BY_ADMINISTRATOR`). Nie zmieniano polityk. Kod wczytywano przez `page.set_content`; użyto jawnego magazynu pamięciowego. Testy sprawdzają serializację i zachowanie przy odmowie zapisu, nie natywną trwałość file:// po zamknięciu przeglądarki.

Media testowane atrapami urządzeń. Nie ma dowodu jakości realnego mikrofonu, kamery, udostępnionego ekranu, audio systemowego ani transmisji między osobami.

Zrzuty są z działającego HTML-u, nie z generowania obrazów. Sprawdzono m.in. 390, 760, 1100 i 1440 px. Podglądy celowo pokazują lokalne przewijanie szerokiego kanbanu; nie jest to ucięcie kart bez dostępu.

## Ograniczenia, których nie ukrywamy

- AI to lokalny ekstraktor i agent regułowy. Nie rozumie wszystkich luźnych decyzji i nie pracuje po zamknięciu strony.
- Nie ma backendu, prawdziwego konta, SSO, autoryzacji serwerowej, MCP ani współedycji. Lokalna filtracja nie jest zabezpieczeniem danych.
- Live nie przesyła mediów do kolegi; lista i dołączenie innych osób są demonstracją.
- Brak wirtualizacji dla dużych map/rozmów, pełnego indeksu wyszukiwania, semantycznego rankingu i OCR załączników.
- Wyszukiwanie wiki dotyczy bieżącej treści. Nie przeszukuje binarnych załączników i wszystkich dawnych wersji.
- Archiwum zachowuje historię faktycznie dostępną. Nie rekonstruuje wcześniejszych odcięć ani pełnego replayu ruchów mapy.
- Kontrola walidacji JSON nie jest niezależnym security auditem. Pliki są jawne i niezaszyfrowane.
- 108 par kontrastu nie oznacza całego WCAG, pełnej dostępności czytników ani przetestowania wszystkich focus/error/hover states.
- Nie wykonano badania z osobami z ADHD ani dowodu wzrostu produktywności.
- Źródła v11 nadal rozwijają prototyp przez warstwę uzupełniającą, nie są finalnym projektem skalowalnego frontendu.

## Zalecana kolejna weryfikacja

Nowa osoba bez instruktażu: powrót do projektu, wybór prywatnego zakresu, otwarcie źródła i kontynuacja; udostępnienie dziecka mapy; odszukanie istniejącego zadania; import z zachowaniem autorstwa. Następnie prawdziwy storage na stałym origin i urządzenia docelowych użytkowników. Nie deklarujemy, że te testy już wykonano.
