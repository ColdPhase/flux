# Flux — MCP-first, lokalni agenci i GitHub per workspace

Wersja: 0.2 • 30 września 2026 r.  
Status: poprawiona specyfikacja do implementacji. Nie jest działającym serwerem MCP, integracją GitHuba ani zmianą HTML-u.

## 0. Korekta obowiązującego kierunku

Ta wersja zastępuje wcześniejszą propozycję w zakresie uruchamiania zewnętrznych agentów, lokalnej kontroli kosztów oraz granic integracji GitHuba.

Flux wspiera dwie osobne ścieżki:

1. **Agent przypięty we Fluxie** — dotychczas zaprojektowany asystent rozmów i materiałów, z konfiguracją dostawcy, własnymi wykonaniami, propozycjami oraz rozdzieleniem wspólnego i prywatnego wyniku.
2. **Flux MCP** — zewnętrzny agent, np. Codex CLI lub Claude Code, działa na komputerze właściciela. Flux udostępnia mu ograniczone operacje na projekcie i koordynację współpracy.

Nie budujemy dla drugiej ścieżki chmurowych środowisk kodowania, floty VM, zarządzanych przeglądarek ani hostowanego terminala we Fluxie. Nie uruchamiamy serwera Codexa jako usługi Fluxa tylko po to, aby podłączyć narzędzia projektu. Użytkownik nadal pracuje we własnym kliencie.

W tym dokumencie **workspace oznacza istniejący niezależny projekt/grono Fluxa**, odpowiadający obecnemu `space`. Nie wprowadzamy dodatkowej, nadrzędnej organizacji do modelu produktu. Integracje nie dziedziczą się między workspace'ami, DM ani szkicownikiem.

## 1. Podział odpowiedzialności

```text
KOMPUTER HUBERTA                         KOMPUTER MARKA
Codex CLI                               Claude Code
własne konto modelu                     własne konto modelu
lokalne repo / git / terminal            lokalne repo / git / terminal
lokalne testy / przeglądarka / Docker    lokalne testy / przeglądarka / Docker
         |                                       |
         +--------- Flux MCP przez HTTPS --------+
                                |
                zakres: konkretny workspace
                                |
            WSPÓLNE OPERACJE DOMENOWE FLUXA
              /                 |                  \
   interfejs użytkownika   wbudowany asystent   GitHub connector
                                |                  |
                    zadania / wiki / wyniki     repo bindings
                    przekazania / historia      webhooki / API
                                                   |
                                    GitHub repo / PR / issues / CI
```

MCP to protokół dostępu do kontekstu i narzędzi; host, taki jak Codex lub Claude Code, zarządza modelem i jego pracą [S1]. Lokalny host nie oznacza lokalnego modelu: dostawca modelu może nadal przetwarzać przekazany kod w chmurze. Flux nie obiecuje, że samo MCP zmienia zasady dostawcy.

| Obszar | Wbudowany asystent | Zewnętrzny agent MCP |
|---|---|---|
| Kto rozpoczyna wywołanie modelu | Wykonawca skonfigurowany dla asystenta | Lokalny host użytkownika |
| Gdzie są poświadczenia modelu | W bezpiecznej konfiguracji przewidzianej dla asystenta | W natywnym kliencie właściciela, poza Flux MCP |
| Dostęp do danych Fluxa | Operacje domenowe z polityką | Te same operacje przez MCP, z odrębnym grantem |
| Shell, pliki, przeglądarka | Nie są dodawane przez tę specyfikację | Narzędzia lokalnego hosta |
| Gdzie jest koszt | Według rzeczywistego wykonawcy asystenta | U dostawcy/local hosta właściciela |
| Co kontroluje Flux | Własne wykonania i skutki | Swoje API, przydziały i akceptację wyników; nie całe urządzenie |

Wyłączenie wbudowanego asystenta nie wyłącza automatycznie MCP. Odłączenie MCP nie usuwa GitHuba. Odłączenie repo nie kasuje zadań. Każdy skutek ma osobną, opisaną kontrolkę.

## 2. Architektura backendu

Proponowany pierwszy serwer: modularny backend FastAPI, PostgreSQL i magazyn obiektów dla świadomie wysyłanych artefaktów. MCP, UI API i wbudowany asystent wywołują te same funkcje domenowe. Nie implementujemy trzech różnych wersji `utwórz zadanie` lub `zapisz wynik`.

Potrzebne są niewielkie zadania techniczne backendu: webhooki, outbox, rekonsyliacja stanu GitHuba i publikacja zdarzeń. Nie są one workerami uruchamiającymi lokalne modele. Koordynator zapisuje dostępną pracę i przyznaje dzierżawy na prośbę klienta; nie wybiera po cichu innej subskrypcji.

Wbudowany asystent zachowuje dotychczasową semantykę: wskazane źródła, wersjonowane propozycje, kontrolę zmian i brak publikacji prywatnego podsumowania we wspólnej rozmowie. Nie musi obsługiwać komunikacji dwóch zewnętrznych agentów. Może uczestniczyć w zatwierdzonym zadaniu, ale nie pełni obowiązkowej roli płatnego „przekaźnika”.

## 3. Flux jako serwer MCP

### Transport

Domyślnie zdalny endpoint Streamable HTTP po HTTPS. Zdalny jest serwer danych Fluxa, nie agent. Codex CLI i Claude Code obsługują podłączanie takich serwerów [S2][S3].

Proponowany adres instalacji:

```text
https://flux.example/mcp/workspaces/ws_arduino
```

Adres jest przykładem. Nie istnieje wdrożenie pod tą domeną. Workspace w ścieżce pomaga jednoznacznie nazwać konfigurację, ale nie zastępuje autoryzacji.

Przykładowa konfiguracja po wdrożeniu endpointu i OAuth:

```bash
# Codex — przykład z placeholderem adresu
codex mcp add flux-arduino --url https://flux.example/mcp/workspaces/ws_arduino
codex mcp login flux-arduino

# Claude Code — konfiguracja dla bieżącego lokalnego projektu
claude mcp add --transport http --scope local flux-arduino \
  https://flux.example/mcp/workspaces/ws_arduino
# W uruchomionym Claude Code: /mcp i autoryzacja połączenia.
```

W repo można utrzymywać zatwierdzoną konfigurację bez sekretów. Nowa lub zmieniona konfiguracja serwera nie może być automatycznie zaufana tylko dlatego, że pojawiła się w PR.

Opcjonalny lokalny mostek stdio służy klientom wymagającym lokalnego procesu lub obsłudze powiadomień. Nie jest wymagany w podstawowej integracji HTTP i nie jest pełnym nowym środowiskiem agentowym. Nie udostępnia dowolnego `shell(command)` z serwera Fluxa.

### Uwierzytelnianie

Użytkownik loguje się do Fluxa i zatwierdza zakres dostępu klienta. Flux wydaje własne poświadczenie MCP. Nie przyjmuje w tym miejscu tokenu ChatGPT, Claude.ai ani GitHuba. Standard autoryzacji MCP wymaga właściwego odbiorcy tokenu i zabrania token passthrough [S4].

Domyślnie grant obejmuje jednego właściciela, jednego zewnętrznego agenta i jeden workspace. Rozszerzenie na inne workspace'y wymaga osobnego świadomego nadania uprawnień. Każda operacja sprawdza bieżące członkostwo oraz stan grantu, nie tylko dane z momentu logowania.

Przykładowe uprawnienia Fluxa: `context:read`, `tasks:read`, `tasks:propose`, `tasks:update_assigned`, `coordination:participate`, `results:publish`, `github:read`, `github:propose`. To projektowane uprawnienia aplikacji, nie nazwy narzucone przez MCP.

Projekt w URL, task, repo binding, odbiorca wiadomości i grant muszą wskazywać zgodny zakres. Każdy identyfikator obiektu jest sprawdzany niezależnie. Kursor paginacji i odnośnik artefaktu są również związane z zakresem. Sesja protokołu nie jest tożsamością użytkownika ani zgodą na pracę.

### Proponowane operacje MCP

| Narzędzie | Znaczenie |
|---|---|
| flux_context_get | Krótki brief wskazanego zadania/materiału, wersje i źródła |
| flux_search | Wyszukiwanie wyłącznie w przyznanym zakresie |
| flux_task_get / flux_task_list | Istniejące zadania, nie drugi backlog agentów |
| flux_task_propose / flux_task_update | Kontrolowane zmiany, wersje i dozwolony skutek |
| flux_work_claim | Atomowe przyjęcie pracy, osobny rekord wykonania |
| flux_work_checkpoint | Postęp i jawny stan wznowienia |
| flux_handoff_send | Pytanie, przekazanie lub prośba o review w jednej pracy |
| flux_inbox_read | Tylko nowe przekazania od kursora; bez oznaczania wiadomości człowieka jako przeczytanych |
| flux_result_publish | Wynik z przypiętym SHA, pochodzeniem i zakresem testów |
| flux_github_link | Powiązanie zweryfikowanego obiektu z zadaniem i repo bindingiem |
| flux_github_issue_create / flux_github_pr_create | Opcjonalne zapisy przez integrację workspace'u |

Narzędzia są niezależnie opisane, mają małe schematy i odpowiedzi z limitem/paginacją. Role mogą otrzymywać mniejszy katalog. Resources reprezentują wersjonowane materiały, a prompts — gotowe sposoby rozpoczęcia implementacji lub review. Ich użycie nie oznacza, że wszystkie klienty automatycznie załadują instrukcje lub cały kontekst.

## 4. MCP a ciągła współpraca

**Podłączenie MCP nie jest samo w sobie zleceniem pracy ani mechanizmem budzenia dowolnego terminala.** Host decyduje o użyciu modelu [S1].

Wyróżniamy trzy tryby, aby nie ukrywać ograniczeń:

| Tryb | Uruchamianie modelu | Zachowanie bez pracy |
|---|---|---|
| Na polecenie | Użytkownik wydaje polecenie w lokalnym kliencie | Brak kolejnych wywołań |
| Aktywna praca | Host wykonuje przyjęte zadanie i sprawdza przekazania w punktach kontrolnych | Kończy turę lub przechodzi w obsługiwane oczekiwanie |
| Jawnie włączony dyżur | Funkcja zdarzeń lokalnego hosta albo mały, opcjonalny lokalny adapter | Zwykły proces czeka bez wywoływania LLM |

Przykładem natywnego mechanizmu są Claude Code Channels: zdarzenia docierają do uruchomionej sesji, ale funkcja jest w preview i ma ograniczenia dostępności, list dopuszczonych pluginów oraz zgodności protokołu [S5]. Nie utożsamiamy jej z uniwersalną cechą każdego serwera MCP. Nie zakładamy analogicznej funkcji w dowolnej wersji Codexa bez testu.

Podstawowe MCP musi działać bez dodatkowego daemonu. Tryb dyżuru jest opcjonalny i zależny od przetestowanych możliwości konkretnego klienta. Lokalny adapter, jeśli potrzebny, odbiera małe zdarzenie, sprawdza lokalną zgodę, pobiera autoryzowane zlecenie i używa wspieranej ścieżki klienta. Nie czyta ekranu terminala i nie klika klawiszy jako substytut API.

Długie oczekiwanie w narzędziu MCP może być optymalizacją tylko tam, gdzie wspierają je limity klienta i pośredników. Pętla timeout → pusta odpowiedź → nowa tura modelu nie jest rozwiązaniem „bez tokenów”. Dokumentacja zgodności ma osobno wymieniać obsługiwany transport, wersję protokołu, powiadomienia i wznowienie pracy.

Agent Marka może przyjąć prośbę Codexa Huberta o review wyłącznie w ramach zgody Marka na tę klasę pracy. Samo dodanie MCP nie nadaje takiej zgody. Offline oznacza oczekiwanie; nie uruchamiamy zastępczego modelu we Fluxie.

## 5. GitHub: integracja per workspace

### Rozdzielenie czterech rzeczy

- Konto/logowanie użytkownika GitHub: tożsamość, nie globalna integracja projektów.
- Rejestracja i instalacja GitHub App: techniczny dostęp aplikacji do konta/organizacji i określonych repozytoriów [S6].
- `workspace_integration`: jawna zgoda, ustawienia i odbiorcy danych w jednym workspace.
- `workspace_repository_binding`: przypięte repozytorium, jego polityka, tryb synchronizacji i uprawnienia.

Można współdzielić techniczną rejestrację App lub instalację obsługującą kilka repozytoriów. Nie można przez to współdzielić uprawnień workspace'ów. Każde połączenie i repo binding mają własny stan oraz kontrolę dostępu. Nie tworzymy pola `globalGithubToken`, `currentInstallation` ani wspólnego „aktywnego repo”.

```text
Workspace Arduino + AI
  GitHub: wybrane połączenie
  Repo binding A: firmware
  Repo binding B: dashboard
  Domyślne repo: firmware (wyłącznie podpowiedź)

Workspace Marketplace
  GitHub: osobne zatwierdzone połączenie
  Repo binding C: marketplace
```

Jeden workspace może mieć zero, jedno lub więcej repozytoriów. Model nie zakłada też, że wszystkie pochodzą od tego samego właściciela GitHub. UI może zacząć od jednej prostej akcji dodania repo i stopniowo pokazywać kolejne.

### Proces dodawania

Workspace → Ustawienia → Integracje → GitHub. Administrator wskazuje konto/organizację oraz repozytoria dostępne przez dozwoloną instalację. Akceptuje zakres odczytu, opcjonalne operacje zapisu, odbiorców danych, domyślne repo i reguły importu. Samo zalogowanie GitHubem do Fluxa niczego nie importuje.

Callback powiązania jest chroniony stanem związanym z konkretnym użytkownikiem i workspace'em. Backend ponownie sprawdza rolę we Fluxie, uprawnienie do zarządzania instalacją i dostępność repo; nie ufa samemu `installation_id` podanemu przez przeglądarkę.

Lista repo do wyboru pochodzi z uprawnionego procesu konfiguracji. Zwykły agent workspace'u widzi tylko już zatwierdzone bindingi, nie wszystkie repo administratora. Zwiększenie zakresu GitHub App nie przypina automatycznie nowych repo do workspace'u.

### Kto może zobaczyć dane repo

Dostęp do Fluxa, prawo oglądania danych repo w tym workspace oraz prawo wykonania operacji GitHub są osobnymi uprawnieniami.

Proponowany bezpieczny domyślny profil dla prywatnego repo: treść integracji jest widoczna osobom mającym również zweryfikowany dostęp do repo. Członek bez takiego dostępu może nadal pracować z własnym zadaniem Fluxa, lecz nie dostaje ukrytego tytułu PR, kodu ani zewnętrznych komentarzy.

Jawny profil alternatywny — udostępnianie wskazanej treści repo całemu workspace'owi przez App — wymaga decyzji osoby uprawnionej do takiego udostępnienia i akceptacji polityki organizacji. UI musi pokazać, że jest to faktyczne poszerzenie odbiorców. Nie dajemy takiej możliwości zwykłemu agentowi.

Scope repo i filtr etykiet/ścieżek to różne rzeczy: filtr służy porządkowaniu, nie izoluje tajnych części repo przed jego uprawnionym klonowaniem. Usunięcie połączenia zatrzymuje przyszły dostęp przez nie, ale nie cofa już pobranych kopii i świadomie opublikowanych materiałów.

## 6. Integracja z istniejącymi zadaniami

Zadanie Fluxa pozostaje samodzielne. Repo jest opcjonalnym kontekstem, nie nowym obowiązkowym formularzem tworzenia zadania.

Dodatkowa rozwijana sekcja „GitHub” może zawierać repozytoria, issue źródłowe, powiązane issue, gałąź, PR-y, commity i wyniki CI. Jedno zadanie może wymagać PR w firmware i PR w dashboardzie. Jeden PR może świadomie realizować kilka zadań. Nie modelujemy relacji jako `task.github_pr_url`.

Proponowane relacje: `source`, `implements`, `verifies`, `related`. Powiązanie samo w sobie nie jest blockerem. PR zamknięty bez scalenia nie kończy pracy. Scalenie nie potwierdza automatycznie działania urządzenia. Użytkownik może pracować z zadaniami bez włączonych agentów.

### Dwa tryby pracy z issue

**Powiązanie — domyślne:** task Fluxa i issue pozostają różnymi obiektami. Widać stan i źródło, ale opisy nie nadpisują się wzajemnie.

**Zadanie oparte na issue — opcjonalne:** wybrane issue może utworzyć zadanie bez ponownego przepisywania danych. Każde pole otrzymuje jednoznacznego właściciela synchronizacji; stan issue i stan wykonania Fluxa pozostają osobne. Nie importujemy wszystkich issue przy podłączeniu repo.

| Pole | Reguła domyślna |
|---|---|
| Tytuł, opis, osoba, termin zadania Fluxa | Edytowane we Fluxie; nie nadpisywane webhookiem |
| Tytuł, opis i stan issue | Odczytywane z GitHuba |
| Aktualne SHA, stan PR i CI | GitHub jako źródło techniczne |
| Kryteria odbioru i potwierdzenie efektu | Flux |
| Rozmowy | Oddzielne źródła; brak bezwarunkowego kopiowania komentarzy w obie strony |
| Milestone GitHuba | Powiązany zakres techniczny, nie automatycznie cel Fluxa |

Zamierzone tworzenie issue/PR lub publikowanie komentarza z Fluxa pokazuje docelowe repo i odbiorców. Publiczny GitHub może mieć szersze grono niż prywatny workspace. Nie kopiujemy automatycznie prywatnych rozmów, tytułów zadań, briefów ani linków ujawniających istnienie innych workspace'ów.

Numery takie jak `#42` są wyłącznie etykietami w obrębie repo. Klucze używają hosta dostawcy, stabilnego ID repo i ID obiektu. Ścieżka `owner/name` oraz URL służą prezentacji i są aktualizowane po zmianach. Transfer repo wymaga ponownej kontroli uprawnień i zgodności bindingu.

## 7. Dwa sposoby działań na GitHubie — jedna historia we Fluxie

### Lokalnie, uprawnieniami właściciela

Agent używa lokalnego Git/CLI lub lokalnie skonfigurowanego GitHub MCP. Klonuje repo, tworzy gałąź, uruchamia testy i wypycha zmianę jak jego właściciel. Poświadczenia zostają w lokalnej konfiguracji. Flux odbiera wynik przez webhook i/lub jawne powiązanie MCP.

To naturalna domyślna ścieżka zmian kodu. Nie tworzymy nowej implementacji Gita we Fluxie. Sama deklaracja agenta, że PR istnieje, nie jest potwierdzeniem — connector odczytuje obiekt z dozwolonego repo.

### Przez narzędzia Flux MCP

Tworzenie issue, PR, powiązań albo kontrolowany zapis informacji może przechodzić przez connector danego workspace'u. Serwer sprawdza uprawnienia i dobiera zawężony token App; token nie trafia do odpowiedzi MCP. GitHub pozwala ograniczyć token instalacji do konkretnych repozytoriów i uprawnień [S7].

Domyślny profil obserwacji jest odczytowy. Profil zapisu dodaje wyłącznie wymagane operacje issues/PR. Uprawnienia do merge, modyfikacji zawartości, administracji, workflow czy sekretów nie są domyślnym dodatkiem do odczytu repo. Implementacja mapuje każdą operację na aktualne wymagania konkretnego endpointu GitHuba.

### Granica egzekwowania

Flux kontroluje tylko operacje wykonane przez Flux. Cofnięcie grantu MCP nie odbiera użytkownikowi jego niezależnego uprawnienia `git push`. Nie można obiecać blokady wszystkich lokalnych zmian, limitu całego abonamentu ani zdalnego zatrzymania terminala na podstawie samego MCP.

Niezależne zabezpieczenia repo, w tym wymagane review i status checks, powinny być egzekwowane przez GitHub [S8]. Instrukcja agentowa wspiera zachowanie, ale nie zastępuje zabezpieczenia repo i ustawień lokalnego hosta.

## 8. Webhooki, wiele workspace'ów i brak wycieków

Proces przyjęcia:

```text
GitHub webhook
 -> weryfikacja podpisu i typu zdarzenia
 -> trwałe przyjęcie + deduplikacja
 -> identyfikacja instalacji, repo i obiektu
 -> niezależne dopasowanie aktywnych repo bindingów
 -> sprawdzenie filtra i uprawnień każdego workspace'u
 -> aktualizacja jego powiązań
 -> małe zdarzenie dla właściwej pracy / adresata
```

Stosujemy podpisane webhooki, szybkie potwierdzenie po trwałym przyjęciu i asynchroniczną obsługę. `X-GitHub-Delivery` pozwala rozpoznać powtórzenie; redelivery zachowuje ten sam identyfikator [S9].

Odbiór deduplikujemy na poziomie zaufanego connectora, a dostarczenia osobno dla bindingów. Zaznaczenie całego webhooka jako obsłużonego po dostarczeniu do A nie może zgubić dostarczenia do B. Retry sprawdza aktualny stan powiązania, nie odtwarza starego dostępu po revokacji.

Jeśli to samo repo jest jawnie połączone z dwoma workspace'ami, współdzielone mogą być dopuszczone fakty GitHuba, nie rozmowy, zadania, agenci ani plany Fluxa. Nie ujawniamy drugiemu workspace'owi nawet listy pierwszego grona. Polityka odczytu repo ma pierwszeństwo przed filtrem porządkowym.

Dla wspólnego issue dopuszczamy wiele świadomych odnośników, ale nie dwie konkurencyjne automatyzacje przepisujące ten sam tytuł i opis. Bidir synchronizacja określonego pola ma jednego właściciela; konflikt zatrzymuje zapis zamiast „ostatni zapis wygrywa”.

Klucze cache, indeksy wyszukiwania, signed URLs, błędy, kursory, powiadomienia, propozycje asystenta i kontekst MCP również uwzględniają workspace i wersję uprawnień. Globalny techniczny rekord instalacji nie staje się globalnym źródłem materiałów dla modeli.

Rekonsyliacja nadrabia brakujące zdarzenia i niepewne operacje. Prywatny, niedostępny z internetu self-hosted Flux może korzystać z jawnego okresowego odczytu API zamiast webhooków; to kod techniczny, nie pętla LLM. UI pokazuje opóźnienie synchronizacji. Nie wymuszamy publicznego portu na laptopie agenta.

## 9. Minimalny model danych i transakcji

| Encja | Kluczowe informacje |
|---|---|
| workspaces / obecne spaces | Granica danych i grona |
| assistant_configs | Konfiguracja istniejącego asystenta, niezależna od MCP |
| workspace_integrations | workspace, provider, installation_ref, stan, zakres, polityka odbiorców, auth_epoch |
| workspace_repository_bindings | workspace, integration, repo ID/host, gałąź domyślna, synchronizacja, wersja zasad |
| task_repository_links | workspace, task, binding, opcjonalnie rola repo |
| task_external_links | workspace, task, binding, typ i stabilne ID obiektu, relacja |
| external_agent_registrations | właściciel, nazwa/harness jako deklaracja, zakres konfiguracji |
| mcp_grants | użytkownik, agent registration, workspace, scopes, ważność, revokacja |
| collaboration_sessions | Lokalna sesja pracy: przyjęty zakres, tryb dyżuru, dostępność |
| work_claims | task/work item, agent, lokalna sesja, generacja, termin dzierżawy |
| handoffs / coordination_events | nadawca z autoryzacji, adresat, task, typ, krótki payload, sekwencja |
| evidence_records | repo/commit, wynik, zakres testów, źródło: lokalna deklaracja lub CI |
| webhook_deliveries / binding_deliveries | deduplikacja odbioru i dostarczenia |
| operation_intents / outbox | zamiar skutku, idempotencja, stan potwierdzenia lub unknown |

Lokalna sesja pracy jest rekordem domenowym, nie założeniem o stanowości samej wersji MCP. Agent podłączony do odczytu nie ma automatycznie aktywnego `run`.

Wymagane własności:

- Powiązania między taskiem, repo bindingiem, grantem i workspace'em mają złożone ograniczenia kluczy obcych. Sam losowy UUID nie chroni przed przekazaniem cudzej referencji.
- Domyślne repo jest najwyżej jedno na workspace, ale jego zmiana nie przepina historycznych tasków/PR-ów.
- Jeden aktywny autor danej jednostki pracy. Dwa atomowe claim nie przyznają tej samej dzierżawy. Review może być osobną jednostką wskazującą konkretny SHA.
- Stara generacja nie może zatwierdzić wyniku lub zakończyć pracy we Fluxie. Nie twierdzimy, że powstrzyma niezależny lokalny push do GitHuba.
- Ponowne dostarczenie tej samej operacji zwraca ten sam skutek lub jego aktualny stan. Timeout po utworzeniu PR daje `unknown`; najpierw sprawdzamy GitHuba, potem ewentualnie ponawiamy.
- Nie obiecujemy globalnego exactly-once między Postgres a GitHubem. Stosujemy idempotencję i uzgadnianie stanu.
- Sesja w workspace A nie zmienia zakresu dlatego, że człowiek otworzył B w przeglądarce.

## 10. Kontekst, przekazania i tokeny

Wspólna pamięć to wersjonowane źródła z wiki/zadań/repo oraz indeks referencji, nie druga autonomiczna wiki ani pełny transkrypt terminala. Prywatna pamięć właściciela nie jest publikowana. Brief zawiera cel, przyjęty zakres, kryteria, zakazy i potrzebne referencje.

Przykładowy komunikat:

```json
{
  "type": "review.requested",
  "task_ref": "task:fx128",
  "repo_binding_ref": "repo:firmware",
  "pr_number": 42,
  "head_sha": "7a8f1e04b5716d8f94d3953fa94eedb1762390cc",
  "focus": "Sprawdź timeout i reconnect.",
  "evidence_refs": ["evidence:test018"]
}
```

Nadawcę i workspace ustala serwer. Numer PR jest rozwiązywany wyłącznie w tym repo bindingu. Osobny rekord wskazuje docelowego recenzenta i jego zgodę. To kontrakt propozycji, nie wdrożony endpoint.

Optymalizacja obejmuje: mały katalog narzędzi, odpowiedzi z paginacją, kontekst na żądanie, zmiany od kursora, wersje/hash źródeł, raporty strukturalne zamiast pełnych logów oraz brak budzenia modelu dla heartbeat/ACK/pustej kolejki. Krótkie pytanie merytoryczne nadal jest dozwolone.

Flux nie widzi automatycznie całego użycia tokenów lokalnego Codexa lub Claude Code. Może mierzyć swoje wywołania MCP i rozmiar zwracanych danych, lecz nie wyciąga z tego prawdziwego kosztu modelu. Użycie zgłoszone przez klienta ma etykietę pomiaru lub szacunku. Brak telemetrii oznacza „brak danych”, nie zero kosztu.

Samodzielne czytanie pełnego czatu przez lokalnego agenta poza potrzebnym zakresem nadal może być kosztowne. MCP daje możliwość lepszej pracy, nie automatyczną gwarancję najniższego zużycia. Limit lokalnego modelu egzekwuje lokalny host/dostawca; Flux może ograniczyć nowe przydziały i własne operacje.

Lokalny plik/cache skraca odczyty, ale nie gwarantuje oszczędności przetwarzania kontekstu przez model. Celu nie wyrażamy niezmierzonym procentem oszczędności. Porównujemy koszt zaakceptowanej zmiany i jakość wyników.

## 11. Review, testy i UI

Agenci wykonują lokalnie zwykłe testy, Docker i przeglądarkę, jeśli ich środowisko je udostępnia. Brak narzędzia lub urządzenia zgłaszają jako brak weryfikacji. Flux przechowuje świadomie wysłane wyniki; nie przechwytuje automatycznie całego pulpitu, katalogu domowego ani transkryptu.

Raport lokalny ma dokładny SHA, zakres, polecenie, wynik i pochodzenie. Sam podpis przesyłającego nie dowodzi uczciwości/testowego pokrycia. Niezależne CI na GitHubie jest osobnym źródłem. Przy Arduino kompilacja nie zamyka kryterium dotyczącego realnej lampki.

Review agenta, approval człowieka i zgoda systemu na merge są rozróżnione. Gdy PR lub review publikuje wspólna App, nie udajemy niezależnych osobistych tożsamości. Gdy agent używa lokalnego konta właściciela, autorstwo GitHuba nadal nie oznacza, że człowiek osobiście przeczytał kod. Nowy commit wymaga ponownej kontroli aktualności oceny.

GitHub branch protection / rulesets chronią główną gałąź niezależnie od tego, czy zmiana przyszła przez Flux, CLI czy inną integrację [S8]. Automerge jest jawną opcją repo bindingu w granicach repo, nie skutkiem zgody na samo MCP. Agent nie może sam rozszerzyć integracji lub wyłączyć bramek.

### UI bez zmiany całego produktu

Wbudowany agent pozostaje w dotychczasowym miejscu. Zakładka Agenci pokazuje zewnętrznych uczestników pracy, zadania, przekazania i wyniki. Integrację GitHub konfiguruje się w ustawieniach workspace'u, a jej efekty widać przy istniejących taskach.

Przykładowe etykiety: „Codex Huberta · lokalnie”, „Claude Code Marka · lokalnie”, „Oczekuje na uruchomienie sesji”, „Review PR #42”, „Wynik lokalny”, „CI potwierdzone”. Tożsamość harnessu jest deklarowana, chyba że system rzeczywiście ma wiarygodną metodę jej potwierdzania.

Nie wyświetlamy „pracuje” na podstawie samego istnienia konfiguracji MCP. Odróżniamy: skonfigurowany, ostatnio połączony, pracuje nad zgłoszonym zadaniem, czeka na właściciela, utracono kontakt. Podajemy czas ostatniego potwierdzenia. Brak heartbeat nie dowodzi, że lokalny proces przestał liczyć.

„Zatrzymaj przydzielanie” działa w zakresie Fluxa. „Poproś o przerwanie lokalnej pracy” jest żądaniem do zgodnego hosta; bez potwierdzenia nie zamienia się w „proces zatrzymany”. Użytkownik może lokalnie zatrzymać swój terminal. Odłączenie MCP odcina nowe operacje we Fluxie, nie prywatne działania użytkownika poza nim.

## 12. Życie integracji

Stan repo bindingu: pending_authorization → active → degraded/suspended → disconnected. Każdy stan ma określone dopuszczone odczyty/zapisy i czytelną przyczynę.

Odłączenie repo pozostawia historię oraz odnośniki z etykietą zatrzymanej synchronizacji. Wyłącza jego zapisy i automatyczne przydziały wymagające tego repo. Zmiana nazwy aktualizuje etykietę; nie tworzy nowego repo. Transfer, usunięcie, utrata uprawnień lub zmiana prywatności wymagają rekonsyliacji i kontroli odbiorców.

Odłączenie powiązania w A nie odinstalowuje wspólnej GitHub App i nie niszczy B. Odinstalowanie App po stronie GitHuba może zatrzymać wszystkie zależne bindingi; UI pokazuje rzeczywisty zasięg, ale nie ujawnia innym gronom ich nazw/danych.

Przeniesienie taska między workspace'ami nie przenosi automatycznie grantów, repo ani zewnętrznych treści. Wymaga dozwolonego docelowego bindingu i jawnej kontroli udostępnienia. Bez niego link pozostaje historyczny/niedostępny albo jest odpinany w świadomej operacji.

Eksport przenosi materiały w dozwolonym zakresie i historię, nie poświadczenia, aktywne dyżury i zgody na wykonanie. Importowane referencje GitHuba są nieaktywne do ponownego potwierdzenia. Import nie tworzy issue/PR ani nie wznawia terminala.

## 13. Kryteria odbioru — do wykonania

To plan testów, nie wyniki już uruchomionego systemu.

| Próba | Oczekiwane zachowanie |
|---|---|
| OAuth login GitHub bez konfiguracji projektu | Żadne repo nie zostaje automatycznie przypięte |
| Podpięcie firmware do Arduino | Brak firmware w Marketplace i jego MCP |
| Agent A podaje task, repo, kursor lub artefakt z B | Odmowa bez ujawnienia treści B |
| Więcej repo w instalacji niż w bindingu | Agent widzi tylko zatwierdzone repo workspace'u |
| Dodanie repo do GitHub App | Brak automatycznego rozszerzenia workspace'u |
| Dwa workspace'y jawnie wskazują to samo repo | Osobne taski, granty, kontekst i komunikacja |
| Webhook ma dwa legalne bindingi | Dwie idempotentne dostawy; awaria jednej nie gubi drugiej |
| Duplikat webhooka / ponowienie operacji MCP | Brak podwójnego taska, PR, review lub wyniku |
| Zadanie bez repo | Pełna normalna obsługa bez błędu |
| Zadanie obejmuje dwa repo | Dwa jawne powiązania i wspólne kryteria odbioru |
| `#42` istnieje w dwóch repo | Jednoznaczne rozwiązanie według bindingu |
| PR zamknięty bez merge | Zadanie nie kończy się samo |
| PR merged, test sprzętu nieodbyty | Kryterium sprzętowe pozostaje niespełnione |
| Zmiana source SHA po review | Stara ocena nie uprawnia do odbioru nowej rewizji |
| Członek Fluxa bez dostępu do prywatnego repo | Brak podglądu repo w domyślnym profilu widoczności |
| Publikacja prywatnego briefu do publicznego issue | Brak automatycznej publikacji; jawny wybór treści i odbiorcy |
| Cofnięcie MCP podczas lokalnej pracy | Brak nowych operacji Fluxa; brak fałszywej deklaracji zatrzymania terminala |
| Zamknięty klient Marka | Prośba czeka; brak użycia konta innej osoby |
| MCP-only klient bez powiadomień | Tryb na polecenie działa, automatyczność nie jest udawana |
| Wyłączenie wbudowanego AI | Zewnętrzne MCP działa według własnego grantu |
| Brak raportowania tokenów | „Brak danych”, nie pozorny zerowy koszt |
| Odłączenie repo w A | B nie traci własnego poprawnego bindingu |
| Niepewny timeout po utworzeniu PR | Rekonsyliacja przed ewentualnym ponowieniem |
| Import archiwum | Brak aktywacji agentów, poświadczeń i GitHub writes |

## 14. Kolejność realizacji

Najpierw wspólne, serwerowe operacje domenowe i ACL; następnie GitHub per workspace oraz powiązania istniejących tasków. Dalej Flux MCP do odczytu, propozycji i wyników z natywnych lokalnych klientów. Na tym fundamencie: przekazania, claim i wznowienie pracy dwóch osób. Automatyczny dyżur dopiero z potwierdzoną zgodnością hosta; nie blokuje podstawowego MCP.

Nie jest wymagane utworzenie wewnętrznego środowiska kodowania we Fluxie, infrastruktury GPU, farmy przeglądarek, lab runnerów ani obowiązkowej współdzielonej subskrypcji. Oszczędzamy zakres wykonawczy, ale nie pomijamy autoryzacji, synchronizacji i kontroli źródeł.

## Źródła i granice

Baza produktowa: załączone ARCHITECTURE.md (agent projektu i granica produkcyjna), FLOW.md (wynik/wiedza), README.md (agent i Git/CI) oraz IMPORT_EXPORT.md (workspace jako projekt/grono i brak automatycznego wznawiania po imporcie).

Źródła zewnętrzne sprawdzone 30 września 2026 r. Własne nazwy tabel, narzędzi, adresy, polityki i scenariusze powyżej są propozycją Fluxa. Zgodność wymaga implementacji i testów z konkretnymi wersjami klientów.

- [S1] MCP Architecture overview: https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture
- [S2] OpenAI, Codex MCP: https://developers.openai.com/codex/mcp/
- [S3] Anthropic, Connect Claude Code to tools via MCP: https://code.claude.com/docs/en/mcp
- [S4] MCP Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- [S5] Anthropic, Channels: https://code.claude.com/docs/en/channels
- [S6] GitHub, Installing your own GitHub App: https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
- [S7] GitHub, Authenticating as an installation: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- [S8] GitHub, About protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- [S9] GitHub, Webhooks best practices: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
