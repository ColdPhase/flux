# Flux Studio 11.6 — wykonana weryfikacja

30 września 2026. Testy lokalnego prototypu, nie audyt działającego serwera, transportu MCP ani integracji GitHub.

## Finalne wyniki

**501 automatycznych sprawdzeń logiki i interakcji: 501 zaliczonych, 0 niepowodzeń.** Liczba oznacza opisane asercje, nie 501 niezależnych pełnych scenariuszy.

| Zestaw | Wynik | Raport |
|---|---:|---|
| Domena kooperacji i rekordy bazowe | 114 / 114 | `tests/domain-report.json` |
| Rozmowa, szkice, przewijanie i animacja | 72 / 72 | `tests/conversation-report.json` |
| Zachowane przepływy redesignu | 95 / 95 | `tests/redesign-report.json` |
| Mapa, typografia i edytor wiki z 11.5 | 111 / 111 | `tests/polish-report.json` |
| Nowe reguły wiadomości, ról i review 11.6 | 109 / 109 | `tests/flow116-report.json` |
| Wybrane warianty geometrii — osobno | 240 / 240 | `tests/layout116-report.json` |
| Wybrane pary kontrastu tekstu — osobno | 54 / 54 | `tests/contrast116-report.json` |

Szerokości w teście geometrii: 320, 390, 900, 1440 px; dwa motywy; trzy akcenty; dziesięć konfiguracji: U mnie, rozmowa, mapa, lista gałęzi, zadania, wiki, edycja wiki, Agenci, przekazanie i punkt przekazania. Szeroki kanban i płótno przewijają się we własnym kontenerze. Sprawdzano granice wybranych elementów i viewport, nie każdy możliwy stan, ekranową klawiaturę lub zoom.

Najniższy zmierzony kontrast w wybranych parach tekstowych: **5,665:1**. To dziewięć par na sześć wariantów, nie pełny audyt wszystkich stanów focus/disabled, kontrolek, linii, obrazów ani zgodności WCAG. Kolor aktywnego tła wiki celowo nie stanowi jedynego sygnału wyboru; pozostaje etykieta, punkt i aria-current.

Końcowe raporty nie zgłosiły błędów JavaScript. Testy domeny/rozmowy oraz release smoke kontrolowały brak zewnętrznych żądań aplikacji. Końcowe sprawdzenie dokumentacji HTML potwierdziło brak wyjścia poza szerokość 390 px.

## Co konkretnie sprawdzono

Nowy task publikuje jeden wpis task.created. Pierwszy komentarz staje się rootem z własnym autorem/treścią, kolejne są odpowiedziami. Pierwsze pliki, blokada i wynik zachowują źródło. Stare wątki nie są przepisywane. Tworzenie i wysyłanie cofają zapis po wymuszonej odmowie storage; szkice i załączniki pozostają. Niedostępny odnośnik jest odrzucany bez ujawnienia jego treści. Import nie emituje ogłoszeń ponownie.

Mapa ma sam licznik i istniejący wybór wszystkich ID. Kamera pozostaje niezmieniona. Podświetlenie drag jest wyłącznie na liście kart; zachowano upuszczanie przez nagłówek kolumny. Wiki ma subtelny stan i aria-current. Edytor dokumentowy/Markdown, szkice, historia i dotychczasowe formatowanie mają zachowane testy.

Przekazanie cudzemu wykonawcy czeka na jego właściciela, inny profil nie może zatwierdzić jego zgody. Przypisanie człowieka jest osobne. Testowano zamianę ról, zachowanie wpisanej wskazówki, przyjęcie/odmowę, przekazanie istniejącej pracy i przywrócenie poprzedniej jako paused, zakres projektu, wybór własnego agenta do review i zgodę ograniczoną do wykonania/generacji.

Kod: aktualny SHA, uwagi, poprawka, CI, ponowna ocena i osobny odbiór. Wynik bez repo: wiadomość źródłowa, jej wersja, doręczenie wybranemu recenzentowi, ponowna ocena po edycji, blokada odbioru starej wersji. Import/backup nie przenosi aktywnej zgody. Sprawdzenia animacji obejmują rzeczywiste klatki, reduced-motion i zatrzymanie za modalem. Nie utożsamiają widocznej animacji z rzeczywistym wykonaniem modelu.

## Zgodność i zakres zmian testów

`tests/compatibility116-report.json`: wczytano przykładowy stan oryginalnej 11.5 do nowej 11.6. `tasks`, `nodes`, `edges`, `maps`, `boards`, `pages`, `fragments`, `messages`, `anchors`, `effects`, `spaces` pozostały identyczne. Schemat pozostał 11. Nie dopisano historycznych ogłoszeń ani nie zmieniono kotwic podczas ładowania. Sprawdzono również przykładowy układ mapy bez nakładania n1/n3 i etykietę wydania. To nie dowód zgodności dowolnej uszkodzonej lub zmodyfikowanej bazy.

Testy bazowe dostosowano w miejscach świadomie zmienionego kontraktu: wybór taska przez licznik zamiast inline tytułu, szerokość nowego wskaźnika 34 px, numer wydania i rozdzielenie delivery wykonania od delivery review. Nie usuwano całych historycznych zestawów. Finalne pięć zestawów uruchomiono po ostatniej zmianie HTML-u.

W jednym wcześniejszym przebiegu test formatowania linku w wiki nie przeszedł; kolejne pełne przebiegi przeszły bez zmiany implementacji formatowania. Nie jest to potwierdzona naprawa przyczyny. Stabilność tego przypadku i inne silniki przeglądarek wymagają dalszej kontroli. Błędy pierwszych iteracji nowych testów oraz pomocniczego skryptu zrzutów zostały poprawione; raporty w paczce są z zakończonych finalnych przebiegów.

## Środowisko i ograniczenia

Chromium **144.0.7559.96**, Playwright, rzeczywisty DOM. Próba otwarcia finalnego pliku przez `file://` została odrzucona z **ERR_BLOCKED_BY_ADMINISTRATOR**. Nie obchodzono polityk. `tests/native116-report.json` zachowuje wynik tej próby.

Testy używały `page.set_content` i jawnego magazynu pamięciowego. **Nie potwierdzono trwałości natywnego localStorage po zamknięciu przeglądarki.** Test serializacji, odtworzenia stanu i rollbacku nie jest testem dysku.

Nie testowano prawdziwego GitHuba, LLM, MCP, niezależnych komputerów, obciążenia, współbieżnych serwerowych zapisów, hardware ani transmisji Live. Nie wykonano pełnego audytu bezpieczeństwa, dostępności, czytników, IME, pełnej regresji każdej historycznej funkcji ani badania użyteczności. Demo nie egzekwuje limitów abonamentu lokalnego agenta, nie mierzy tokenów i nie potwierdza jakości review.

Zrzuty pochodzą z rzeczywistego DOM, GIF z klatek rzeczywistego statusu Canvas. Nie używano generatora obrazów do podglądów wydania. Dane scenariusza (np. liczby testów przy PR) są demonstracyjne i oddzielne od uruchomionych tu testów aplikacji.

## Wydanie

`tests/release116-report.json` potwierdza etykietę, ładowanie finalnego pliku bez błędów, brak sieci, zgodność raportów i czytelność opisu HTML na mobile.

SHA-256 `flux-studio-v11.6.html`:

```text
5c0f26dd05709d18d0a8c28bfa412bc29948f4b49f2738ac5c537ddbe4f943e7
```

Polecenia ponowienia znajdują się w README. Zachowaj pełny backup przed podmianą; 11.2–11.6 dzielą klucz magazynu na tym samym originie. Oryginalną 11.5 pozostawiono bez zmian.
