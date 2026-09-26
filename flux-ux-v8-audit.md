# Flux v8 — audyt i zakres weryfikacji

## Co było rzeczywistym problemem

v7 przechowywał powiązania, ale ich prezentacja wymagała zrozumienia modelu danych. Podobnie wyglądające linki prowadziły do bardzo różnych materiałów. Zadanie miało kilka pól o podobnym charakterze. Użytkownik nie mógł łatwo przewidzieć, gdzie pojawi się komentarz, blokada albo wynik.

W v8 główną zmianą są wspólne widoki kontekstu i publikacja pracy przez jedną wiadomość, a nie dodawanie kolejnego modułu.

## Poprawki zweryfikowane w kodzie i przeglądarce

| Sytuacja | Zachowanie po poprawce |
|---|---|
| Link obok rozmowy nie mówił, czym jest materiał | Widoczny typ, nazwa nadrzędna, treść i rola powiązania |
| Wyjście do mapy gubiło orientację | Dokładne zaznaczenie myśli i powrót do źródłowego wątku ze szkicem |
| Komentarz z zadania wyglądał jak osobna dyskusja | Jedna wiadomość w kanonicznym wątku, widoczna w obu miejscach |
| Dwa pola pisania dla jednego zadania | Jedno aktywne miejsce; przekazanie szkicu przy otwieraniu i zamykaniu panelu |
| Pole wyniku dublowało rozmowę i notatkę na mapie | Wskaźnik do wiadomości z wynikiem, odczytywany w innych widokach |
| Wynik na mapie uruchamiał zbędną propozycję agenta | Mapa odczytuje go sama; agent proponuje wersjonowaną obserwację w wiki |
| Wynik zmieniony po propozycji aktualizacji wiki | Stara propozycja jest oznaczana jako nieaktualna |
| Fragment wiki wstawiał się do starego, niewidocznego pola | Odnośnik trafia do aktualnego szkicu wybranego wątku |
| Układ mapy odejmował szerokość panelu drugi raz | Skala wykorzystuje rzeczywistą szerokość płótna |
| Banner agenta przykrywał powrót z mapy | Nie jest wyświetlany na przycisku powrotu / przy otwartym panelu |
| Odpowiedź AI pojawiała się podczas pisania | Zachowanie szkicu, kursora i świadomego położenia w historii |

## Metoda

Chromium sterowany przez Playwright. Testy uruchamiają rzeczywisty HTML z przypiętą wyłącznie w środowisku testowym implementacją pamięciowego Storage. Część działań przygotowuje stan przez publiczne funkcje prototypu; są oznaczone jako testy modelu lub mieszane. Nie są to wyłącznie kliknięcia człowieka.

Środowisko blokuje nawigację `file://` komunikatem `ERR_BLOCKED_BY_ADMINISTRATOR`. Dlatego nie przedstawiamy testu `set_content` jako weryfikacji natywnego otwarcia pliku i zachowania localStorage po restarcie. Właściwy dostarczony HTML nie ma podmiany Storage.

Rzeczywiste zrzuty sprawdzono wizualnie dla rozmowy, panelu zadania, mapy, agenta i widoku telefonu. Automatyzacja obejmuje 1500 px, 1024 px oraz 390 px; zrzuty desktopowe wykonano przy 1600 × 1050. Nie są to testy na fizycznym telefonie, Safari ani Firefox.

## Wynik końcowy

**41 / 41 scenariuszy zaliczonych. Brak nieobsłużonych wyjątków JavaScript w sprawdzonych przepływach.** Szczegółowe wyniki, rodzaj testu i czas znajdują się w `flux-ux-v8/tests.json`.

Najważniejsze grupy: nawigacja do dokładnych materiałów, zachowanie szkicu, jeden komentarz w wielu widokach, blokada i odblokowanie, bieżący wynik, osobisty punkt powrotu, rozdzielone pola czasu, ruch i cofanie mapy, nieprzechodnie sąsiedztwo, komentarz do linii, wzmianki, fragmenty i użycia wiki, kolejność zadanie→mapa z dokładnego źródła, podstawowe tablice, autor AI, nieaktualne propozycje, ekran mobilny i odtworzenie zserializowanego modelu.

Nie wykonano pełnej regresji wszystkich wcześniejszych funkcji. Szczególnie import dowolnych starych plików, duże projekty, masowe zmiany, zaawansowane Markdown, wszystkie kombinacje ustawień i każdy przypadek usuwania powiązanych danych wymagają dalszych testów.

## Ograniczenia prototypu

**Autoryzacja:** wszyscy przykładowi uczestnicy i materiały znajdują się w jednym pliku. Reguły grona to demonstracja. Nie używać do sekretów. Agent nie ma produkcyjnego izolowanego konta.

**Współpraca:** brak serwera, synchronizacji na żywo, transakcji i rozwiązywania konfliktów wielu użytkowników. Lokalne sprawdzenia nieaktualnej propozycji nie zastępują systemu wersjonowania w backendzie.

**AI:** deterministyczne demonstracje, bez rozumowania LLM i bez dostępu do kodu lub kont. Kontekst używany przez symulator nie dowodzi poprawności przyszłego agenta.

**Integracje:** MCP, SSO, Git/CI, realni wykonawcy AI, e-mail i push nie są połączone. Przypomnienia nie działają jako usługa po zamknięciu pliku.

**Dokumenty:** prosty renderer i źródło Markdown, nie pełny bezpieczny produkcyjny edytor. Odnajdywanie cytatu korzysta z tekstu i jego otoczenia. Potrzebne są stabilne bloki, archiwalne wersje cytowanych elementów i dodatkowe testy złożonej treści.

**Wyniki:** nowe wyniki używają wiadomości jako źródła. Automatyczna propozycja wiki dopisuje obserwację ze wskazaniem zadania; nie stanowi żywej kopii aktualizującej tekst wiki po każdej zmianie testu. Późniejsza redakcja wiki wymaga kolejnej decyzji.

**UI:** podział głównego komentarza i szerszej dyskusji jest obecnie jawny. Dobór gęstości panelu kontekstu, wielkość podglądów oraz tryby wiadomości muszą być ocenione z użytkownikami. Nie potwierdzono kompletnej zgodności WCAG ani skuteczności ADHD.

**Kod:** warstwa integracyjna nad v7 zachowuje stary globalny model i listenery. To nie docelowy stos aplikacji. Nowy resolver relacji powinien zostać przeniesiony do testowanej warstwy domenowej, a komendy do autoryzowanego backendu.

## Następny test użyteczności

Dać osobie nieznającej projektu zadanie: odnaleźć warunek wiki z rozmowy, zgłosić przeszkodę, po jej usunięciu opublikować wynik i odnaleźć go na mapie. Nie tłumaczyć modelu. Obserwować, czy przewiduje skutek, nie tworzy duplikatów i nie pyta, gdzie zniknął szkic. Wynik takiego testu nie został jeszcze zebrany.
