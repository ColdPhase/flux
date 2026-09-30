# Flux Studio 11 — zmiany względem 10

## Powrót i hierarchia

- Usunięto dużą sekcję „Najbliższy efekt” znad rozmowy.
- Jeden zwijany cel pod nazwą: tytuł, kryterium ukończenia, istniejące zadania, świadome potwierdzenie i historia kierunków.
- Co ważne ma stałe miejsce obok zakładek. Powrót ze źródła nie przesuwa przycisków.
- Usunięto drugi, powielony punkt dostępu do panelu AI z dawnego paska powrotu.
- Zakres od faktycznie zapisanej wizyty w projekcie zamiast domyślnej demonstracji tygodnia. Odczyt wiadomości pozostaje osobny.
- Prywatne podsumowanie na górze: cały projekt / dotyczy mnie. Wynik nie jest publikowany w rozmowie, powiadomieniach ani wspólnym logu.
- Ekstrakcyjny DEMO z cytatami i zapisanymi wynikami; nie podłączono LLM.

## Praca i mapa

- Nakład przyjmuje liczbę i jednostkę minut/godzin/dni/tygodni, zachowaną w UI. Termin i plan nie zmieniają się.
- Nowe karty kanbanu: tytuł, powód blokady albo wynik, źródło, osoba, termin, nakład, prywatny plan.
- Czytelna minimalna szerokość kolumn i lokalne przewijanie zamiast ściskania kart.
- Wyszukiwarki zadań, wszystkich map projektu i treści wiki. Działają także na telefonie.
- Lista mapy ma gałęzie, wcięcia, prowadnice, rozwijanie i połączenia boczne. Obsługuje cykle bez powielania myśli.
- Poprawiono udostępnianie dziecka: dokładny element jest celem, nie rodzic w starym panelu.
- Zaznaczenie lub dopisanie nowej gałęzi usuwa nieaktualny panel poprzedniego elementu.
- Wyszukiwanie/podglądy zachowują szkice i kontekst.

## Wizualne

- Zwykłe wiadomości AI dziedziczą komponent wiadomości ludzi. Robot/autor/DEMO pozostają.
- Dziewięć statycznych akcentów × dwa tła; Mięta zachowana, pozostałe odświeżone i rozszerzone.
- Brak custom pickerów, HEX i dowolnego koloru organizacji.
- Responsywne pole Znajdź we Fluxie, lokalne wyszukiwarki, wiki i nagłówki.

## Dane

- Schemat 11 i nowy klucz magazynu; migracja pełnych backupów 09/10 jest jawna.
- Eksport pojedynczego projektu z zachowaną treścią, autorstwem, plikami i dostępną historią.
- Brak osobistych szkiców, podsumowań, przeczytania i preferencji w archiwum projektu.
- Import tworzy nową kopię, przepina ID i źródła. Konta nie są scalane po nazwie.
- Historyczny autor nie oznacza nowego konta z prawami do logowania.
- Import wyłącza projektowe AI, archiwizuje propozycje i nie wznawia sesji.
- Walidacja, podgląd, jawne przypisanie własnej tożsamości, ochrona przed powtórnym importem tego samego pliku i wycofanie przy błędzie zapisu.
- Pełny backup pozostaje oddzielną, wyraźnie opisaną operacją.
- Brak dalszego automatycznego obcinania wiki przy 40 wersjach i audytu przy 500 wpisach. Nie odzyskuje to danych odciętych przez stare wydania.

## Zachowane

Messengerowy strumień, jedna warstwa odpowiedzi, @, dokładne cytaty, blokery/rozwiązania/wyniki, źródła, wiele map i tablic, przeciąganie i cofanie, Markdown, przypomnienia lokalne, prywatne projekty i DM, proaktywny agent regułowy oraz Live przy materiale.

## Nadal poza zakresem lokalnego HTML-u

LLM, połączenia MCP/Git/CI, prawdziwe konta i SSO, serwerowe ACL, współedycja, zdalny audio/video transport, harmonogram poza otwartą stroną, szyfrowany storage. Nie są ukrytymi „gotowymi” funkcjami.
