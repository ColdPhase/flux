# Studio 11.1 — rzeczywiście wykonana weryfikacja

## Wyniki tej iteracji

**58/58 nowych scenariuszy DOM w Chromium: PASS.** Zestaw w `tests/test_polish.py`, końcowy log w `tests/run.log`.

**84/84 wybranych par kontrastu: co najmniej 4,5:1.** Minimum: **4,624:1**. 14 par tekst/tło × 3 akcenty × 2 motywy. Wyniki i użyte pary w `tests/contrast.json`, obliczenia w `tests/contrast.py`.

Sprawdzono składnię JavaScript złożonego HTML-u narzędziem `node --check`. Przesłane źródła składały się dokładnie do przesłanego `flux-studio-v11.html`; punktem wejściowym nie była niezgodna lub starsza kopia kodu.

## Obszary testów DOM

- Start samodzielnego pliku, wersja/schemat, brak zewnętrznych arkuszy i skryptów.
- Dokładnie trzy palety, rzeczywiste próbki dla obu teł, osobne zapamiętane wybory, mapowanie dawnych dziewięciu opcji, zakładki ustawień i fokus.
- Mały przycisk skrótu i zachowana główna akcja zatwierdzenia; pusty zakres, licznik zakresu, brak publikacji prywatnego wyniku i anulowanie po zmianie zakresu/profilu/okresu.
- Stabilny snapshot przy nowej wiadomości, otwarcie źródła i powrót, osobny stan odczytu i zatwierdzenia, zapamiętanie rozwiniętego objaśnienia.
- Poprawny początkowy układ drzewa, relacja między głęboką i płytką gałęzią, brak automatycznego reparentingu, cykle, brak duplikowania myśli, archiwizacja rodzica i jednorazowe wnioskowanie metadanych.
- Zmiana rodzica w UI, zachowanie współrzędnych i źródeł, odrzucenie potomka/innej mapy, cofnięcie/ponowienie, świadomy poziom główny.
- Zaznaczenie bez otwierania panelu, szkic bez rekordu przed zapisem, anulowanie bez pustej myśli, edycja F2, szkic przy przełączeniu widoku, wielowierszowy tekst i niewykonywanie HTML-u, odniesienie do źródła.
- Łączenie na liście, rozwinięcie ścieżki celu i powrót, strzałki bez zmiany współrzędnych, menu klawiaturowe, dokładne udostępnienie dziecka zamiast starego rodzica.
- Zachowanie przewinięcia i szkicu rozmowy, kamery płótna przy zmianie widoku/mapy, prywatność archiwum projektu, przepięcie rodziców podczas importu, preferencje w pełnym backupie.
- 60 dodatkowych poziomów głębokości na szerokości 390 px, kontrola szerokości strony i głównej akcji skrótu przy 320/390/760/1100/1440 px w rozmowie, mapie, zadaniach i wiki.
- Nakład zadania w dniach i niezależne potwierdzenie celu; wycofanie importu przy odmowie zapisu; wejście do projektu bez wymuszonego skrótu; zatrzymanie podążania przy własnej nawigacji; reduced motion.
- Fokus w modalu i po jego zamknięciu, brak działania mapowych skrótów Delete/strzałek w modalu, czyszczenie sesyjnych szkiców listy przy zmianie profilu.

## Zrzuty

`tests/capture.py` zapisuje rzeczywisty DOM wynikowego HTML-u. Obejrzano kluczowe widoki 1440 i 390 px: domowy, prywatny skrót, ciemną listę, mobilną listę oraz ustawienia jasnego motywu. Dodatkowe zrzuty obejmują edycję w miejscu, wybór rodzica i pusty zakres.

Głęboka gałąź i boczne połączenia na zrzutach pochodzą z jawnego fixture `DEEP` w `tests/harness.py`. Nie są startowymi danymi dodanymi do dostarczanego HTML-u. Zrzuty nie są makietami wygenerowanymi przez model obrazowy.

## Środowisko i ograniczenia

Nawigacja Chromium do `http://127.0.0.1:8765` została zablokowana jako `ERR_BLOCKED_BY_ADMINISTRATOR`. Nie zmieniano polityk. HTML został wczytany przez `page.set_content`; `localStorage` jest jawną atrapą pamięciową z możliwością symulowania odmowy zapisu. Sprawdzono serializację i reakcję na błąd, **nie natywną trwałość danych na file:// lub localhost po zamknięciu przeglądarki**.

Nie uruchomiono dawnych 169 testów opisanych w wejściowym audycie: tych plików testowych nie było w załącznikach. Dokumentacja wejściowa została zachowana bez zmian w `docs/v11/` i nie jest raportem tej iteracji. 58 scenariuszy nie oznacza pełnej regresji każdej funkcji Studio 11.

Nie wykonano badań użyteczności z ludźmi, pełnego audytu WCAG, testów czytników ekranu, realnych urządzeń mobilnych, Safari/Firefox ani dużych baz produkcyjnych. Brak wirtualizacji listy i grafu pozostaje ograniczeniem. Nie wykonywano niezależnego security audytu.

Nie testowano zdalnej transmisji audio/video ani prawdziwego LLM, ponieważ aplikacja ich nie implementuje. Wyniki nie są dowodem gotowości produkcyjnej.
