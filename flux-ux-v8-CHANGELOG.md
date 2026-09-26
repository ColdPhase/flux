# CHANGELOG — Flux v8 względem v7

## Zmieniono przepływ, nie tylko kolor odnośników

### Rozmowy

- Lista nazwanych wątków, wybrana rozmowa i materiały znajdują się obok siebie.
- „Dotyczy” zastąpiono podglądami z typem, treścią i wyjaśnieniem powiązania.
- Myśli są grupowane pod nazwą właściwej mapy; kliknięcie wskazuje konkretny element.
- Wzmianki nie są przedstawiane jako komentarze ani zobowiązania.
- Wypowiedź źródłowa pokazuje, które zadanie lub myśl z niej powstały.
- Podgląd zachowuje szkic i kontekst powrotu.
- Rośnięcie odpowiedzi AI przewija rozmowę tylko, gdy użytkownik jest na jej końcu.

### Zadania

- Opis jest czytelną treścią z osobną edycją, nie stale otwartym polem.
- Jedno miejsce pisania: Wiadomość, Przeszkoda lub Wynik. Skutek jest opisany przed wysłaniem.
- Gdy to samo zadanie jest otwarte przy swojej rozmowie, pozostaje jedno aktywne miejsce pisania. Szkic przechodzi między widokami.
- Przeszkoda wskazuje tę samą wiadomość co jej powód, nie tworzy dodatkowej kopii komentarza.
- Wysłanie wyniku przypina wiadomość do zadania; odczyt z mapy używa tego samego wyniku.
- Nowy wynik zachowuje poprzednią wypowiedź w historii.
- Osobisty punkt powrotu, termin, szacunek i plan dnia zachowują odrębne znaczenie.

### Mapy

- Uspokojone linie i podgląd komentowanego połączenia z nazwami obu końców.
- Panel wybranej myśli pokazuje zadania, bieżący wynik i materiały wiki.
- Źródło i sąsiedztwo nie powodują automatycznego scalania wątków.
- Usunięto podwójne odejmowanie szerokości panelu przy dopasowaniu płótna i odsłanianiu myśli.
- Powrót do rozmowy nie jest przykrywany propozycją agenta.
- Ograniczono nadmiar oznaczeń na płótnie; źródło rozmowy pozostaje dostępne w kontekście myśli.

### Wiki i odnośniki

- Typ materiału jest widoczny również wewnątrz zdania; nie tylko w kolorze.
- Podgląd fragmentu pokazuje cytat, dokument i wersję.
- Strona pokazuje rzeczywiste użycie w zadaniach i na mapie.
- Komentarze do fragmentów są dostępne w Rozmowach i przy źródłowej stronie.
- Naprawiono wstawianie cytatu do widocznego szkicu rozmowy po zmianie układu interfejsu.
- Zachowano ostrzeżenie o zmienionym albo niejednoznacznym fragmencie.

### Agent demonstracyjny

- Wynik jest widoczny z mapy bez angażowania agenta.
- Automatyczna propozycja dotyczy teraz dopisania obserwacji do jednoznacznie powiązanej wiki, nie zbędnego kopiowania wyniku na mapę.
- Sprawdzana jest aktualność zarówno strony, jak i źródłowego wyniku przed zastosowaniem.
- Brak LLM, zewnętrznych połączeń i rzeczywistego MCP pozostaje jawny.

### Techniczne

- Nowe widoki korzystają z `v8Graph`, `v8Context` i wspólnej funkcji `v8Publish`.
- Zachowano wcześniejsze tablice, tabelę, Home, import/eksport Markdown i ustawienia jako bazę.
- Aktualny eksport oraz pomoc oznaczają wersję v8.
- Osobny klucz magazynu `flux-ux-v8-local`; brak automatycznej migracji poprzednich danych.
- Źródło pozostaje warstwą nad v7. Nie jest pełnym refaktorem produktu.

## Weryfikacja

41 scenariuszy Chromium — 41 zaliczonych, 0 niepowodzeń. Raport i skrypt są w pakiecie. To nie pełna regresja całej historii prototypu ani badanie z użytkownikami. Ograniczenia wczytania pliku i trwałości magazynu opisuje audyt.
