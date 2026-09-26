# Flux Studio v8

**Rozmowa prowadzi do materiałów i pracy, a nie do kolejnego katalogu odnośników.**

Lokalny, interaktywny prototyp UX. Wersja 8 przebudowuje widoczność powiązań między rozmowami, mapami, zadaniami i wiki. Nie jest wdrożeniem wieloużytkownikowym. Agent, osoby, autoryzacja, SSO, MCP oraz Git/CI pozostają demonstracją.

## Uruchomienie

Otwórz `flux-ux-v8.html` w aktualnej przeglądarce. HTML zawiera style i kod; nie wymaga procesu budowania, konta ani instalacji zależności. Zaczyna się od przykładowej rozmowy projektu **Arduino + AI**. Marketplace ma odrębny skład.

Alternatywnie, w katalogu pliku można uruchomić lokalny serwer:

```bash
python -m http.server 8080 --bind 127.0.0.1
```

Następnie otwórz `http://127.0.0.1:8080/flux-ux-v8.html`. Jest to tylko podanie statycznego pliku, nie uruchomienie backendu Fluxa. Nie wystawiaj prototypu jako narzędzia do przechowywania poufnych materiałów.

Ważne dane eksportuj do JSON. Prototyp próbuje używać lokalnego magazynu przeglądarki pod kluczem `flux-ux-v8-local`. Dane wcześniejszej wersji nie są automatycznie usuwane ani migrowane. Pełna migracja dowolnego starego eksportu nie jest zweryfikowana.

## Co zobaczysz od razu

Po lewej są rozmowy aktualnego projektu, w środku wybrany wątek, a obok materiały uporządkowane według znaczenia:

- **Praca omawiana tutaj** — zadanie z wykonawcą, stanem i krótką treścią.
- **Pomysł rozrysowany na mapie** — nazwa mapy oraz konkretne myśli, nie ogólny link do płótna.
- **Wiki użyte w zadaniu** — właściwy fragment z cytatem, tytułem dokumentu i wersją.

Wzmianki oraz bezpośrednio sąsiadujące myśli są oddzielone od materiałów faktycznie dotyczących rozmowy. Nie trzeba ręcznie tworzyć tych kart: nowe widoki wyliczają je z istniejących, jawnych powiązań.

## Przepływ do sprawdzenia

1. W rozmowie **„Czy kamera zadziała po ciemku?”** kliknij zadanie w prawym panelu. Rozmowa pozostanie na miejscu.
2. Napisz zwykłą wiadomość z panelu zadania. Zobaczysz ją również w tej samej rozmowie projektu — nie zostaje wysłana druga kopia.
3. Wybierz **Przeszkoda**, napisz powód i wskaż Marka. Wysłanie oznaczy pracę jako oczekującą na pomoc. Wykonawcą pozostaje Hubert. Wiadomość jest równocześnie powodem blokady.
4. Kliknij **Odblokuj**. Historia pozostaje, a zadanie nie zmienia się na ukończone.
5. Wybierz **Wynik**, wpisz obserwację z testu i opcjonalnie zaznacz zakończenie zadania. Ta jedna wiadomość zostaje bieżącym wynikiem.
6. Otwórz **Kamera + rozpoznawanie gestu** z kontekstu rozmowy. Przy myśli zobaczysz zadanie i ten sam wynik. Nie powstaje dodatkowa notatka z kopią tekstu.
7. W tym przykładzie zadanie ma jeden wskazany dokument wiki. Symulator agenta przygotuje propozycję dopisania obserwacji. Dokument zmieni się dopiero po zaakceptowaniu propozycji.

Na mapie przycisk **Wróć do rozmowy** prowadzi do właściwego wątku i zachowanego szkicu. Podgląd zadania i wiki również nie kasuje rozpoczętej odpowiedzi. Gdy panel pokazuje zadanie z tej samej rozmowy, aktywne jest jedno miejsce pisania, a nie dwa konkurujące formularze.

## Mapa i rozmowy

Mapa zachowuje przesuwanie, edycję dwuklikiem, dopisywanie plusem, łączenie istniejących myśli, zaznaczenie grupy, układ, przybliżanie i cofanie. Plus i połączenie istniejących bloków tworzą tę samą zwykłą relację.

Połącz Kamerę z Czujnikiem. W kontekście rozmowy będzie dostępna bezpośrednio sąsiadująca myśl. Nie zostaną scalone ich rozmowy ani utworzone zadania. Po zaznaczeniu linii można komentować samo połączenie. Jeden wątek ma wtedy dwa końce mapy jako kontekst.

Wynik zadania nie jest decyzją o wyborze rozwiązania. Ukończenie testu kamery nie oznacza, że kamera została zaakceptowana.

## Wiki i odnośniki

`@` wskazuje materiał. Odnośnik ma widoczną nazwę typu: mapa, wiki, zadanie albo rozmowa. Wspomnienie zadania nie zmienia jego stanu i nie kopiuje wypowiedzi do jego komentarzy.

Zaznacz tekst w wiki i wybierz odwołanie do rozmowy. Fragment trafi do aktualnie widocznego szkicu wiadomości; nie zostanie wysłany bez potwierdzenia. Podgląd fragmentu pozwala otworzyć właściwe zdanie w źródle, skomentować je, umieścić odniesienie na mapie lub dołączyć je do zadania.

Strona wiki pokazuje, gdzie jest używana. Cytat w historycznej wypowiedzi zachowuje treść, do której odnosił się autor. Po zmianie źródła aplikacja ostrzega, jeśli nie potrafi jednoznacznie zlokalizować cytatu. Mechanizm nie jest pełnym edytorem blokowym z trwałą tożsamością każdego akapitu.

Import, edycja i eksport Markdown oraz historia stron pochodzą z wcześniejszych wersji. Nie ma synchronizacji dokumentacji z repozytorium.

## Trzy różne informacje przy zadaniu

**Termin** jest datą ukończenia, **Mój plan** osobistym wyborem dnia pracy, a **Nakład** orientacyjnym szacunkiem czasu. Mają osobne kontrolki. Prywatny punkt powrotu pozostaje w sekcji osobistej, nie tworzy komentarza ani blockera.

Kanban i tabela są widokami tych samych zadań. Projekt może mieć wiele tablic i map. Liczby map i tablic nie muszą się zgadzać.

## Agent: dokładny zakres demonstracji

Nie ma połączenia z LLM ani płatnym API. `/ai` uruchamia zachowane, regułowe przykłady. Agent występuje jako **Flux · agent AI · demo**.

Nowy przepływ automatyczny uruchamia się po opublikowaniu wyniku, gdy zadanie ma jeden jednoznacznie wskazany dokument wiki. Proponuje dopisanie obserwacji, nie zmianę kierunku. Nie dopisuje wyniku do wszystkich dokumentów projektu. Nie zgaduje celu przy wielu dokumentach.

Przy zastosowaniu sprawdzana jest wersja dokumentu i aktualność źródłowego wyniku. Zmieniony wynik blokuje starą propozycję. Nie ma semantycznego wykrywania sprzeczności, samodzielnego researchu ani nadzoru nad repozytorium.

## Co sprawdzono

`flux-ux-v8/tests.json` zawiera wynik **41 scenariuszy, 0 niepowodzeń** w Chromium. Są to testy interakcji, modelu danych i podstawowych regresji. Nie oznaczają pełnego audytu bezpieczeństwa, dostępności, wieloużytkownikowości ani badania skuteczności u osób z ADHD.

Polityka środowiska testowego blokuje `file://`. Testy oraz zrzuty wykonano przez wczytanie HTML w Playwright i testowy magazyn pamięciowy. Właściwy plik HTML nie zawiera tej podmiany. Zweryfikowano serializację i odtworzenie stanu z testowego magazynu, **nie trwałość natywnego localStorage po zamknięciu pliku**.

Zrzuty przedstawiają faktyczne ekrany tego HTML-u. Stan z blokadą/wynikiem został uzyskany interakcjami w prototypie.

## Pliki w pakiecie

- `flux-ux-v8.html` — gotowy prototyp.
- `README.md`, specyfikacja, CHANGELOG i audyt — dokumentacja.
- `flux-ux-v8/` — ekrany i raport testów.
- `source/base-v7.html`, `source/v8.js`, `source/v8.css`, `source/build.py` — baza oraz nowa warstwa.
- `tools/test_v8.py`, `tools/capture_v8.py` — odtwarzalne testy i zrzuty.

Budowanie nie jest wymagane do używania HTML-u. Do odtworzenia:

```bash
python source/build.py
python -m pip install playwright
python -m playwright install chromium
python tools/test_v8.py flux-ux-v8.html wyniki-testow
```

Kod v8 jest warstwą integracyjną nad prototypem v7. Nie należy przedstawiać go jako docelowej architektury produkcyjnej. Przed wdrożeniem potrzebny jest refaktor do wspólnych komend, repozytorium relacji, serwerowej autoryzacji i obsługi współbieżnych zmian.
