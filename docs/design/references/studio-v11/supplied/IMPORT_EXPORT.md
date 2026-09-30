# Przenoszenie projektów — Studio 11

## Dwa różne formaty

1. **Archiwum projektu:** `format: "flux.workspace"`, `formatVersion: 1`, `data.schema: 11`. Jeden projekt dodawany jako nowa kopia.
2. **Pełny backup:** obiekt bazy `schema: 9 | 10 | 11`. Jawne zastąpienie lokalnej aplikacji, nie do udostępniania zespołowi.

W tej wersji „workspace” oznacza niezależny projekt/grono. Nie dodaje się obowiązkowej organizacji ponad projektem. W UI zwykle mówimy „projekt”.

## Struktura archiwum

```json
{
  "format": "flux.workspace",
  "formatVersion": 1,
  "archiveId": "archive_...",
  "exportedAt": "ISO-8601",
  "application": "Flux Studio 11",
  "projectId": "id-projektu",
  "projectName": "Nazwa projektu",
  "personalDataIncluded": false,
  "data": {
    "schema": 11,
    "spaces": {}, "users": {}, "messages": {},
    "maps": {}, "nodes": {}, "edges": {},
    "boards": {}, "tasks": {}, "effects": {},
    "pages": {}, "fragments": {}, "anchors": {}, "attachments": {},
    "activity": [], "audit": [],
    "agentRuns": {}, "proposals": {}, "sessionsArchive": {},
    "prefs": {}, "notifications": []
  }
}
```

Powyższy przykład jest opisem kształtu, nie gotowym plikiem do importu. Brakujące lub niespójne rekordy są odrzucane.

## Co jest zachowane

Wiadomości i odpowiedzi, wskazani autorzy, znaczniki czasu, dostępne edycje/wersje, blokery i rozwiązania, wyniki, aktualne mapy z połączeniami, metadane rodziców listy, tablice i zadania, opisy i referencje, wiki z zachowanymi wersjami i cytatami, załączniki zapisane w danych, dziennik aktywności i audyt tego projektu, archiwum agenta i sesji.

Historia nie jest rekonstrukcją nieprzechowywanych informacji. Nie ma nagrań audio, pełnego filmu mapy ani nieograniczonego historycznego cofania. Wersje usunięte przez wcześniejsze limity v10 pozostają niedostępne.

## Czego nie ma w eksporcie projektu

Innych projektów i DM, osobistych szkiców, notatek powrotu, prywatnych skrótów, preferencji, planów i odczytu innych osób, powiadomień, aktywnych strumieni, nowych tokenów logowania oraz poświadczeń integracji. Jawne referencje w treści wychodzące poza zakres są zastępowane niedostępnym materiałem; eksporter nie publikuje treści innego projektu.

**To nie jest anonimizacja.** Autorzy, treść czatu i załączniki są jawne. Hasło w zwykłej wiadomości nadal jest częścią wiadomości. Plik trzeba chronić i posiadać prawo do przeniesienia zawartych danych.

## Tożsamość podczas importu

Nowe ID dla projektu i materiałów eliminują kolizje. Przepisane są ID źródeł, odpowiedzi, relacji, kotwic i tokenów odnośników. Pozostałe projekty nie są modyfikowane.

Nazwy użytkowników nie są kluczem. Domyślnie pierwotni autorzy stają się osobnymi profilami historycznymi. Można świadomie wskazać „ten dawny profil to ja”. Nie przypisuje się historii Marka do innego Marka tylko dlatego, że ma takie samo imię.

Import nie zakłada kont i nie przyznaje innym osobom logowania. Historyczne profile nie pojawiają się w przełączniku kont demo. Obecny użytkownik ma dostęp do importowanej kopii. Produkcyjna wersja wymaga osobnego procesu zaproszeń i weryfikacji tożsamości.

## Reguły bezpiecznego wznowienia

Projektowe AI jest wyłączone. Importowane propozycje/wykonania są tylko historią, bez możliwości automatycznego wykonania. Sesje Live nie wracają do stanu „na żywo”. Stary wynik w historii nie uruchamia nowego procesu tylko wskutek importu.

Ten sam identyfikator archiwum jest wykrywany. Ponowny eksport tworzy nowy identyfikator, więc świadomie nowszą kopię można dodać jako kolejny projekt. **Nie jest to scalanie ani synchronizacja zmian między kopią a źródłem.**

## Walidacja i błędy

Plik: do 32 MB. Podstawowe rekordy: do 50 000. Ograniczenie głębokości, dozwolone formaty załączników, zgodne ID, projekty, autorzy, krawędzie, źródła i typy rekordów. Niedozwolone klucze prototypu są odrzucane. Obce preferencje w archiwum projektu lub historie innego projektu nie są przyjmowane.

Po walidacji jest podgląd liczby materiałów i potwierdzenie prawa do przeniesienia. Import zapisuje nową bazę; błąd magazynu cofa zmianę w pamięci. Ten lokalny model nie zastępuje audytu bezpieczeństwa, transakcyjnego storage ani autoryzacji eksportu na serwerze.

## Pełne odtworzenie

Pełny backup zawiera prywatne dane wszystkich demonstracyjnych profili, więc nie jest odpowiednikiem eksportu projektu. UI pokazuje ostrzeżenie i wymaga potwierdzenia zastąpienia stanu. Backup 09/10 migruje brakujące sekcje do 11. Nie ma automatycznego importu z dawnego localStorage ani migracji v8.

Przed pierwszym przeniesieniem zachowaj osobną kopię oryginalnego JSON-u.
