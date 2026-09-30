# Flux Co-op — RFC architektury i kontraktów

Status: propozycja do implementacji, nie działająca integracja. Wersja dokumentu: 0.1.
Data sprawdzenia dokumentacji zewnętrznej: 30 września 2026 r.

## 1. Decyzja produktowa

Flux koordynuje pracę osobistych agentów nad wspólnym projektem. Nie staje się wspólnym kontem do odpytywania modeli i nie wymaga wymiany istniejącego harnessu. Nowa, opcjonalna zakładka „Agenci” pokazuje pracę, przekazania, dowody i potrzebne decyzje. Zlecenie można rozpocząć przy istniejącym zadaniu lub wiadomości, bez przechodzenia przez dodatkowy dashboard.

Przykład: Hubert dopuszcza swojego Codexa do implementacji i review w projekcie Arduino + AI. Marek osobno dopuszcza swojego Claude Code. Obaj określają zakres i ograniczenia własnego wykonawcy. Wspólna jest praca, nie poświadczenia, prywatna pamięć ani nieograniczony dostęp do cudzej subskrypcji.

Najważniejszy kompromis: automatyczne review po zdarzeniu od drugiego agenta wymaga wcześniejszej zgody właściciela recenzenta na taką klasę zdarzeń. Bez niej powstaje oczekująca prośba. Ukrycie tokenu nie wystarcza do ochrony budżetu.

### Ciągłość z obecną dokumentacją Fluxa

Bazą są załączone ARCHITECTURE.md, FLOW.md i README.md, szczególnie sekcje o agencie, źródłach i docelowym Git/CI. Aktualny HTML pozostaje lokalnym prototypem. Rozszerzenie wymaga prawdziwej tożsamości, ACL, transakcji, workerów i integracji serwerowej.

Zachowujemy różnice między myślą, zadaniem, wiadomością, wynikiem, wiki i potwierdzonym celem. PR nie staje się drugą kopią zadania. Zamknięcie PR bez scalenia nie kończy pracy. Nawet scalenie kodu nie potwierdza automatycznie działania urządzenia.

## 2. Granice systemu

```text
Flux UI / istniejące zadania, rozmowy, wiki
                   |
       API domenowe + autoryzacja
                   |
   Koordynator pracy i silnik polityk
       |           |             |
 PostgreSQL    Broker GitHub   Magazyn artefaktów
 stan/outbox   Writer / Gate   S3-compatible
       |
 adapter / bezpieczne połączenie runnera
       |
 Agent Huberta                  Agent Marka
 własny profil                  własny profil
 własne logowanie               własne logowanie
 własne sesje                    własne sesje
       |                              |
 odizolowany sandbox            odizolowany sandbox
       \                              /
           niezależna weryfikacja CI
```

Rekomendowany pierwszy backend: FastAPI jako modularny monolit, PostgreSQL, magazyn obiektów kompatybilny z S3 oraz osobny proces workerów/runnerów. Frontend może przejść do Next.js bez mieszania logiki uprawnień z komponentami. Kolejka oparta o trwałe rekordy Postgresa i transakcyjny outbox wystarczy jako punkt wyjścia. Powiadomienie o zmianie nie zastępuje trwałego rekordu zadania.

Orkiestrator jest przede wszystkim kodem, nie stale działającym modelem „menedżera”. LLM służy do rozumienia zadania, implementacji i oceny, nie do heartbeatów, oczekiwania na CI czy przekazywania zdarzenia między kolejkami.

### Trzy niezależne osie uprawnień

1. Dostęp człowieka i agenta do materiałów projektu.
2. Zgoda właściciela na zużycie jego połączenia/modelu.
3. Dostęp techniczny do repozytorium i środowisk wykonawczych.

Posiadanie którejkolwiek nie przyznaje pozostałych. Administrator projektu może zatrzymać pracę w swoim projekcie, ale nie może rozszerzyć zgody Marka na zużywanie jego połączenia.

## 3. Połączenia i adaptery

### Ścieżki uwierzytelniania

- Natywny klient: użytkownik loguje się do własnego, niezmodyfikowanego klienta przez natywny proces dostawcy. Flux nie przejmuje sesji Claude.ai ani nie oferuje własnego zamiennika tego logowania. Warunki hostowania Claude Code trzeba spełnić osobno [S1].
- Własny agent oparty na API: poświadczenie API lub zatwierdzonego dostawcy, przypisane właścicielowi i rozliczane odpowiednią ścieżką [S2].
- OpenAI ChatGPT plan usage: istnieje oficjalna ścieżka dla aplikacji OSS/lokalnych; płatne/zdalnie hostowane aplikacje mają odrębną ścieżkę zgłoszenia. Nie należy traktować jej jako domyślnego uprawnienia każdej wersji SaaS [S3].

Te warianty nie mają identycznych możliwości. Aktualny preview ChatGPT plan usage odrzuca m.in. max_output_tokens i część hostowanych narzędzi, ale dopuszcza lokalne narzędzia Codexa. Adapter musi odzwierciedlać rzeczywistą ścieżkę, nie tylko nazwę dostawcy [S4].

### Proponowany kontrakt adaptera

```text
describe_capabilities() -> CapabilityManifest
start(AuthorizedRunEnvelope) -> NativeRunHandle
resume(NativeRunHandle, AuthorizedDelta) -> NativeRunHandle
observe(NativeRunHandle, cursor) -> NativeEvents
cancel(NativeRunHandle) -> CancellationReceipt
usage(NativeRunHandle, cursor) -> UsageDelta | Unavailable
checkpoint(NativeRunHandle) -> ResumeDescriptor | Unsupported
```

CapabilityManifest zawiera co najmniej: harness i wersję, auth_route, start/resume, structured_output, stream, obsługę narzędzi, poziom anulowania, zakres pomiarów użycia, dostępność limitów na pojedyncze wywołanie, tryb sandboxu i atestację wykonawcy. Wartości mogą być supported/unsupported/unknown. Unknown nie jest równoznaczne z supported.

Nie wystawiamy natywnego serwera agenta publicznie. Lokalny mostek nawiązuje uwierzytelnione połączenie wychodzące do Fluxa. Dla Codexa można użyć app-server i komunikacji stdio [S5]. Dla Claude Code dostępne jest wykonanie programowe; tryb --bare wymaga API i nie korzysta z logowania subskrypcyjnego, dlatego nie jest uniwersalnym presetem dla wszystkich użytkowników [S6].

Hermes/OpenClaw są adapterami, a nie fundamentem autoryzacji Fluxa. Backend terminala Docker w Hermes może obejmować wiele sesji jednego procesu [S7]. OpenClaw rozdziela zaufane środowisko operatora od wrogiego multi-tenancy [S8]. Oddzielne osoby nie powinny przypadkowo współdzielić jednego uprzywilejowanego profilu.

A2A to opcjonalna granica interoperacyjności, MCP — narzędzia i kontekst. Obsługa A2A nie oznacza trwałości i pełnego anulowania: aktualny adapter OpenClaw ma ograniczony zakres i pamięciowe zadania [S9]. MCP Tasks wymaga negocjacji wsparcia, a anulowanie jest kooperacyjne [S10]. Trwały cykl życia pracy pozostaje po stronie Fluxa.

## 4. Model tożsamości i zgody

### Główne encje — propozycja

| Encja | Istotne pola / odpowiedzialność |
|---|---|
| agent_connections | owner_user_id, harness, auth_route, secret_ref lub native_profile_ref, capability_version; bez jawnych sekretów w UI |
| agents | principal_id, owner_user_id, connection_id, label; tożsamość odrębna od człowieka |
| project_agent_grants | project_id, agent_id, allowed_actions, repo_ids, task_classes, limits, valid_until, policy_version, revoked_at |
| work_units | flux_task_id, objective_version, approved_scope, acceptance_refs, non_goals, state, parent_work_id |
| agent_runs | work_id, agent_id, grant_id, requested_by, attempt, native_handle_ref, lease_generation, checkpoint_ref |
| work_leases | work_id, run_id, generation, expires_at, heartbeat_at |
| repo_bindings | project_id, GitHub installation_id, repo_node_id, allowed_branches |
| external_refs | flux_ref, provider, repo_node_id, external_node_id, kind, sync_revision |
| coordination_events | event_id, project_id, sequence, kind, authenticated_sender, work_id, causation_id, artifact_refs |
| event_deliveries | event_id, recipient_agent_id, accepted_at, acknowledged_at, cursor |
| evidence_records | subject_sha, environment_digest, command_ref, results, artifact_hashes, producer_identity, trust_level |
| knowledge_records | source_ref, source_version/hash, status, scope, created_by, superseded_by |
| operation_intents | idempotency_key, expected_version, operation, remote_state, reconciliation_state |
| usage_ledger | provider_call_id, run_id, billable_owner, normalized_categories, raw_usage_ref, measurement_quality |

Agent ma principal_id, nie tylko etykietę „Marek” dopisaną do jednego wspólnego users.ai. Zleceniodawca, właściciel połączenia, wykonawca i aktor widoczny na GitHubie mogą być różni i muszą pozostać rozróżnieni.

### Przykładowa zgoda właściciela — dane ilustracyjne

```yaml
project: arduino-ai
agent: marek-claude
owner: marek
allowed_task_classes:
  - implement_approved_work
  - review_approved_project_pr
repository: repo_arduino
allowed_operations:
  - context.read
  - sandbox.run
  - branch.propose_push
  - pull_request.propose
  - review.submit_findings
branch_prefix: flux/marek/
forbidden_paths:
  - .github/workflows/**
  - .flux/policy/**
requires_owner_approval:
  - scope_expansion
  - additional_budget
  - hardware_flash
peer_requests: approved_work_lineage_only
concurrency: 1
repair_rounds: 2
merge: forbidden
```

To domyślna polityka produktu do dostrojenia, nie właściwość Claude Code/GitHuba. Reguły ścieżek muszą być egzekwowane na rzeczywistej zmianie, łącznie z rename/delete i odpowiednio rozwiązywanymi ścieżkami, nie przez sam prompt.

Serwer sam ustala nadawcę, projekt i właściciela z sesji. Model nie może zadeklarować innego ownera w JSON-ie. Każda operacja ponownie sprawdza aktualność zgody. Tokeny/granty nie trafiają do eksportu projektu. Import zachowuje historię jako niewykonywalną i wymaga nowej zgody na ponowne połączenia.

Polityka uprawnień najwyższego poziomu jest egzekwowana poza repozytorium. Repo może przechowywać wersjonowane instrukcje pracy, ale obowiązuje wersja zaakceptowana przez właściciela, nie dowolny plik zmieniony w PR. AGENTS_COOP.md wspiera zachowanie modelu; nie zastępuje kontroli narzędzi, sekretów i brokera.

## 5. Praca i współbieżność

### Maszyna stanów — propozycja

```text
proposed -> awaiting_owner -> ready -> running -> awaiting_review
                                           |            |
                                           v            v
                                        blocked      changes_requested
                                           |            |
                                           +-> ready <-+
awaiting_review -> awaiting_human -> ready_to_merge -> merged
                                                     |
                                      acceptance_pending -> completed
```

Dodatkowe końce: cancelled, failed. Oczekiwanie na quota, dostępność runnera lub CI nie jest automatycznie błędem ani powodem nowego wywołania modelu. Są to nazwane przyczyny oczekiwania.

Jedna jednostka pracy ma jednego aktywnego autora zmian. Równoległe jednostki mają osobne gałęzie i środowiska. Agent realizujący funkcję pisze również jej testy; recenzent weryfikuje wynik, a nie przejmuje całą historię implementacji.

### Dzierżawy i operacje

Claim pracy odbywa się atomowo. Koordynator przyznaje kolejną generację dzierżawy. Po wygaśnięciu i przejęciu pracy stara generacja nie może wykonać nowego push/PR ani zakończyć pracy. Heartbeat obsługuje proces runnera, nie model.

Rezerwacja plików/obszarów pomaga unikać konfliktów, ale nie jest dowodem niezależności zmian. Współdzielony interfejs ma wersjonowany kontrakt i jednego właściciela aktualizacji. Silnie sprzężone prace należy scalić w jedną jednostkę albo wykonać kolejno.

Dostarczenie zdarzeń jest co najmniej jednokrotne. Każde działanie zewnętrzne ma intencję z kluczem idempotencji. Timeout po utworzeniu PR oznacza stan unknown, wymagający sprawdzenia GitHuba przed powtórzeniem. Nie deklarujemy globalnego exactly-once między bazą Fluxa a GitHubem.

Anulowanie najpierw odcina możliwość nowych skutków, potem próbuje zatrzymać procesy. Nie cofa już zaakceptowanego przez GitHuba scalenia ani wywołania dostawcy, którego nie da się zatrzymać. UI rozróżnia „zatrzymano”, „wysłano żądanie zatrzymania” i „skutek już wykonany”.

## 6. Komunikacja bez wspólnego, rosnącego promptu

### Typy zdarzeń

```text
work.assigned, work.blocked, work.checkpointed
interface.changed
review.requested, review.completed, changes.requested
evidence.available
owner.input_required
pull_request.updated, pull_request.merged
run.cancelled, run.failed
```

Nie ma zdarzeń budzących model dla uprzejmego ACK, heartbeatów ani każdej linii logu. Domyślnie wiadomość trafia do adresata/roli przy jednej pracy, nie do wszystkich agentów.

### Przykład krótkiego przekazania

```json
{
  "type": "review.requested",
  "work_ref": "work:gesture-reconnect",
  "pull_request_ref": "github:repo_arduino:pr:42",
  "head_sha": "7a8f1e04b5716d8f94d3953fa94eedb1762390cc",
  "contract_ref": "contract:serial:v3",
  "evidence_refs": ["evidence:test-018"],
  "focus": "Sprawdź timeout i ponowne połączenie po utracie urządzenia."
}
```

Otoczkę event_id, authenticated_sender, grant_id, sequence i causation_id nadaje serwer. Przykład przedstawia payload, nie samodzielne uprawnienie do uruchomienia odbiorcy.

W UI można wyświetlić ten sam fakt jako: „Claude Code Marka przygotował PR #42. Codex Huberta sprawdza timeout i ponowne połączenie”. Tekst powstaje z szablonu oraz krótkiej treści merytorycznej, nie przez dodatkową rozmowę dwóch modeli.

### Minimalne narzędzia Fluxa

| Narzędzie — proponowana nazwa | Odpowiedzialność |
|---|---|
| flux.work.claim | Pobranie autoryzowanej pracy z dzierżawą |
| flux.context.get | Brief i aktualne różnice od potwierdzonej wersji |
| flux.context.search | Wyszukiwanie w dozwolonym zakresie, z paginacją i źródłami |
| flux.artifact.read | Fragment artefaktu/raportu według ID, wersji i zakresu |
| flux.work.checkpoint | Jawny stan wznowienia: co zrobiono, co dalej, źródła |
| flux.handoff.send | Ustrukturyzowana prośba lub wynik, bez dowolnego remote-run |
| flux.change.propose | Intencja modyfikacji zadania/wiki/GitHub z wersjami |
| flux.review.submit | Ocena przypisana do konkretnego head SHA i kryteriów |

Lista narzędzi jest dobierana do roli. Agent nie otrzymuje od razu całego katalogu integracji. Natywne narzędzia kodowania mogą pozostać w harnessie, lecz zewnętrzne skutki projektu przechodzą przez kontrolowany broker.

Nie odbieramy agentowi możliwości dopytania. Dopuszczamy krótkie pytanie z work_ref i reply_to, kiedy kontrakt nie wystarcza. Ograniczamy cykle bez nowego dowodu/zmiany, nie użyteczny dialog.

## 7. Kontekst i pamięć

Wspólna warstwa wiedzy jest logiczną częścią Postgresa i magazynu artefaktów, nie drugim produktem wymagającym utrzymania od pierwszego dnia.

| Rodzaj | Zasada |
|---|---|
| Prywatna pamięć właściciela | Nie trafia automatycznie do projektu ani innych modeli |
| Ustalenie projektowe | Wersjonowane źródło: wiki, zatwierdzony kontrakt lub dokument w repo |
| Hipoteza robocza | Oznaczona jako niezweryfikowana, ograniczona pracą i retencją |
| Dowód wykonania | Niezmienny artefakt, rewizja kodu, środowisko i pochodzenie |

knowledge_record jest indeksem do źródła, nie konkurencyjną wersją wiki. Nie wygrywa najnowsze streszczenie. Zmiana source_hash unieważnia dotyczące go wnioski albo oznacza potrzebę sprawdzenia. Obserwacja z testu może być zapisana automatycznie jako obserwacja; decyzja architektoniczna nie powstaje tylko dlatego, że agent ją zasugerował.

Brief startowy zawiera cel, zakres, zakazy, kryteria, przydzielony fragment repo i referencje do potrzebnych źródeł. Dalszy kontekst jest pobierany według potrzeb. W review trzeba poszerzać diff o wywołujących, konfigurację i zależności tam, gdzie jest to konieczne; oszczędność nie usprawiedliwia ślepej oceny pojedynczych linii.

Wyszukiwanie i cache mają klucz uwzględniający projekt, uprawnienia, wersję źródła i rodzaj reprezentacji. Dedup nie może ujawniać istnienia prywatnych materiałów innemu projektowi. Usunięcie/revokacja wymaga także czyszczenia odpowiednich indeksów i cache; wcześniej przekazanej treści nie da się zdalnie „odzobaczyć”.

## 8. Budżet tokenów

### Proponowane wartości startowe, nie pomiary produktu

| Element | Cel strojenia |
|---|---|
| Brief koordynacyjny | 2–4 tys. tokenów; kod/dokumenty osobno i zależnie od zadania |
| Zwykłe przekazanie pracy | 150–400 tokenów plus odnośniki |
| Wynik testów dla modelu | Liczniki, błędy, minimalny potrzebny fragment; pełny log na żądanie |
| Recenzenci jednego PR | Jeden niezależny recenzent; dodatkowy tylko uzasadnioną regułą |
| Iteracje poprawek | Początkowo dwie; dalsze wymagają świadomego rozszerzenia |
| Oczekiwanie bez nowych danych | Zero nowych wywołań LLM |

Liczba tokenów jest sprawdzana tokenizerem właściwego modelu, a nie rozmiarem gzip lub liczbą znaków JSON. Długie identyfikatory i bardzo małe narzędzia także mają koszt. Najpierw ograniczamy zbędne przebiegi i kopiowanie treści, później stroimy serializację.

Trzy różne mechanizmy: lokalny cache odczytu pliku, skrócenie nowego kontekstu oraz cache promptu dostawcy. Nie wolno sumować ich jako tej samej oszczędności. Native resume może nadal przetwarzać wcześniejszy kontekst. Cache dostawcy ma własne granice i zasady rozliczenia; nie ma współdzielonego cache Claude→Codex [S11][S12].

UsageLedger zachowuje surowe miary oraz normalizację bez podwójnego liczenia kategorii. Klucz provider_call_id/run zapobiega podwójnemu naliczeniu po reconnect. Jeśli harness raportuje kumulatywne użycie wznowionej sesji, obliczamy deltę z poprzedniego watermarku. Szacunek kosztu nie udaje rachunku dostawcy; nieznane użycie oznaczamy jako nieznane.

Budżety obejmują wszystkie próby i potomne prace. Zmiana modelu, nowy numer taska lub delegacja nie resetują limitu nadrzędnego. Dostępność subskrypcji, liczba tokenów oraz koszt API to osobne wielkości. Nie pokazujemy wymyślonego procentu „pozostało 73% abonamentu”.

Przed wywołaniem rezerwujemy szacowany koszt. Gwarancja twardego limitu wymaga obsługi ograniczenia pojedynczego wywołania oraz wiarygodnego pomiaru. Gdy adapter tego nie zapewnia, deklarujemy ograniczenie uruchamiania kolejnych wywołań i możliwość kosztu już trwającego żądania. W trybie wymagającym ścisłego budżetu taka ścieżka powinna zostać odrzucona, zamiast udawać precyzję.

## 9. GitHub i integracja zmian

GitHub pozostaje źródłem prawdy dla PR, commitów, checków i podłączonych issues. Flux przechowuje mandat, uprawnienia agentów, wykonania i kontekst użytkownika. Powiązanie używa stabilnego ID zasobu i repo, nie wyłącznie numeru #42. Każde pole synchronizowane ma określonego właściciela, rewizję i regułę konfliktu. Nie nadpisujemy całego issue przy każdym zdarzeniu.

GitHub App ma minimalne uprawnienia do wybranych repozytoriów. Tokeny instalacji są ograniczane i odnawiane; ich generowanie pozostaje poza modelem [S13]. Webhook jest weryfikowany, trwale zapisywany i obsługiwany asynchronicznie. X-GitHub-Delivery służy deduplikacji redelivery [S14]. Okresowa rekonsyliacja naprawia przerwy i niepewne skutki bez angażowania LLM.

Każda gałąź ma jednego wykonawcę. Git worktree może usprawnić pracę na oddzielnych drzewach, ale nie jest granicą bezpieczeństwa między użytkownikami [S15]. Nie dopuszczamy swobodnego zapisu do main ani force-push poza dozwolonym zakresem.

### Review i scalenie

Ocena agenta jest rekordem: reviewer_agent_id, reviewer_owner_id, work_id, head_sha, zakres sprawdzenia, findingi, evidence_refs. Jest czymś innym niż zatwierdzenie człowieka. GitHub zabrania autorowi zatwierdzania własnego PR; dwóch wykonawców używających tej samej App nie należy traktować jako dwóch odrębnych tożsamości GitHub [S16][S13].

Proponujemy osobny, zaufany serwis Flux Gate. Weryfikuje tożsamość recenzenta, aktualny head SHA, dowody i politykę, a następnie wystawia wymagany check. Runner piszący kod nie ma prawa wystawiać tego checka. W GitHubie wskazujemy oczekiwaną App jako źródło wymaganego statusu [S17]. W silniejszym wariancie Writer i Gate to oddzielne Apps i osobne poświadczenia.

Domyślnie: niezależne review agenta + wymagane testy + akceptacja człowieka. Automerge jest osobną zgodą projektu dla dopuszczonych klas zmian. Zmiany auth, CI/policy, sekretów, wdrożeń lub sprzętu wymagają człowieka; agent nie zmienia zasad, które oceniają jego PR.

Gdy dostępna jest merge queue, testujemy także wynik integracji przez merge_group [S18]. Bez niej serializujemy scalenia i ponownie sprawdzamy aktualną bazę. Wysłanie nowego commitu unieważnia zależne oceny. Potwierdzenie nie może dotyczyć innego SHA niż scalenie. Deployment ma odrębne uprawnienie i bramkę. Revert jest nową zmianą, nie magicznym cofnięciem wszystkich skutków.

## 10. Środowisko i wiarygodność testów

Każda praca otrzymuje kontrolowany obraz i rewizję repo, własny katalog oraz ograniczenia CPU/RAM/dysku/czasu/sieci. W środowisku nie ma katalogu domowego osoby, danych produkcyjnych, sekretów administratora, uprzywilejowanego Dockera ani hostowego socketu Docker. Dostęp do demona ma szerokie konsekwencje uprawnień [S19].

Dla mocnej izolacji między właścicielami preferujemy oddzielne VM/microVM lub równoważną zweryfikowaną granicę. Sam osobny kontener/worktree nie jest wystarczającym uzasadnieniem bezpieczeństwa. Jeśli wybrany natywny harness nie potrafi oddzielić wykonania kodu od swoich poświadczeń, adapter nie może reklamować silnej ochrony sekretów; taki tryb pozostaje ograniczony do świadomie zaufanego lokalnego środowiska albo wymaga innej ścieżki.

Przeglądarka używa świeżego profilu i danych testowych. Playwright może zachować ślad z akcjami, DOM i materiałami diagnostycznymi [S20]. Do modelu trafiają istotne informacje; pełny trace jest artefaktem. Podgląd aplikacji ma osobny origin, autoryzację i nie dziedziczy sesji Fluxa.

CI uruchamia testy na dokładnej rewizji w czystym środowisku. Część kryteriów odbioru powinna pochodzić z zaufanego, niezależnego harnessu. Podpis raportu potwierdza jego pochodzenie, nie to, że testy pokrywają wszystkie błędy. Testy zmienione przez autora wymagają review. Niezaufany kod PR nie uzyskuje sekretów przez uprzywilejowany workflow [S21].

EvidenceRecord zawiera: head/base/ewentualny merge SHA, digest środowiska, polecenie, exit code, liczbę passed/failed/skipped, zakres testów, hash logu/trace, tożsamość wykonawcy i trust_level. „Nie uruchomiono” i „pominięto” nigdy nie stają się „zaliczone”. Dowód z zewnętrznego runnera pozostaje zewnętrzną deklaracją, dopóki nie przejdzie niezależnej weryfikacji.

Dla Arduino: kompilacja, testy jednostkowe i symulacja portu szeregowego nie dowodzą działania realnej lampki. Osobny lab runner ma allowlistę urządzeń i wyłączną dzierżawę. Flash, zasilanie i ryzykowne ruchy wymagają odpowiedniej zgody. UI jawnie pokazuje, czego na sprzęcie nie sprawdzono.

## 11. UX

Zakładka Agenci pojawia się po włączeniu funkcji, ale nie staje się obowiązkową drogą zlecania. Zachowujemy istniejące trzy akcenty i neutralne powierzchnie.

Domyślny widok pokazuje: cel aktualnej pracy, repo, dwie zwięzłe tożsamości i konkretne czynności, wynik wymagający uwagi. Bez fikcyjnego procentu „myślenia”. Szczegóły pracy otwierają panel ze zmianami, testami, kontekstem i historią. Surowe logi są na żądanie.

Rozmowa agentów to czytelna projekcja zdarzeń i celowych wiadomości, nie nowa kopia komentarzy zadania. Główna rozmowa dostaje istotny wynik albo rzeczywistą prośbę o decyzję. Ciągłe przebiegi shell nie zwiększają licznika nieprzeczytanych.

Przełączenie zakładki zachowuje szkic i przewinięcie. Nowe zdarzenie nie przestawia czytanej listy. Prywatne „Co ważne” może uwzględnić wspólne, dostępne efekty pracy, ale nie ujawnia cudzych prywatnych promptów ani pamięci.

Przycisk „Wstrzymaj mojego agenta” dotyczy właściciela. Przycisk „Zatrzymaj pracę w projekcie” jest uprawnieniem projektowym i nie pozwala używać cudzej konfiguracji. Oczekiwanie na zgodę Marka nazywa się tak wprost, zamiast pokazywać niejasny błąd modelu.

## 12. Kryteria odbioru pierwszej integracji

Poniższe scenariusze są wymaganiami, nie raportem wykonanych testów.

| Scenariusz | Oczekiwany wynik |
|---|---|
| Hubert próbuje wywołać dowolny prompt przez połączenie Marka | Odmowa przed wywołaniem dostawcy |
| Dozwolone review pod wcześniej zaakceptowanym mandatem | Uruchomienie wyłącznie w granicach zgody i budżetu |
| Cofnięcie zgody podczas pracy | Brak nowych dozwolonych skutków; jawny status tego, co już trwa |
| Wskazanie prywatnego DM w przekazaniu | Brak treści w kontekście odbiorcy |
| Dwa równoczesne claim tego samego zadania | Jedna aktywna dzierżawa |
| Stary worker powraca po reassignment | Odrzucenie operacji ze starą generacją |
| Ten sam webhook dostarczony trzy razy | Jedno znaczące zdarzenie domenowe / brak trzech PR |
| Timeout po utworzeniu PR | Najpierw rekonsyliacja, bez ślepego powtórzenia |
| Nowy commit po review | Ocena nie uprawnia do scalenia nowego SHA |
| Agent napisze w tekście „wszystkie testy zaliczone” bez dowodu | Brak pozytywnej bramki |
| Kod próbuje wystawić wymagany check | Brak uprawnienia / niewłaściwe źródło statusu |
| Dwa modele używają jednej App | Nie udajemy dwóch ludzkich approvals |
| Limit połączenia jest wyczerpany | Oczekiwanie, bez cichego użycia subskrypcji drugiej osoby |
| Import archiwum z dawnymi runami | Historia, bez wznowienia połączeń i grantów |
| Runner offline | Brak fikcyjnego postępu i nieautoryzowanej zmiany wykonawcy |
| Test sprzętu nie został wykonany | Hardware acceptance pending, nie completed |
| Instrukcja z README żąda sekretów | Traktowanie jako niezaufanych danych; brak skutku |
| Rodzic deleguje wiele nowych podzadań | Wspólny nadrzędny limit nie zostaje ominięty |

### Eksperyment kosztowy

Na tym samym zestawie zadań porównujemy jednego agenta, dwóch agentów z pełnym czatem i dwóch z proponowanym protokołem. Zliczamy wykonane wywołania, nowe/cache-read/cache-write/output tokeny, koszt infrastruktury, czas, interwencje człowieka, regresje i zadania rzeczywiście zaakceptowane. Najważniejsza miara to koszt zaakceptowanej zmiany o wymaganej jakości, nie liczba wiadomości ani PR. Nie zakładamy z góry, że dwa modele będą tańsze; dokumentacja Anthropic również opisuje istotny narzut wieloagentowości [S22].

## 13. Zakres pierwszego wydania

Pierwszy przekrój: prawdziwe konta i projekt, jedno repo, dwóch właścicieli i dwa połączenia, jedna jednostka pracy, osobne środowiska, PR, niezależne review, testy, człowiek zatwierdzający merge, poprawne wznowienie po awarii. Potem dopiero równoległe zadania, szersze adaptery, lab runner i automerge dla wybranych zmian.

Symphony jest przydatnym materiałem do analizy kolejki i izolowanych obszarów pracy, ale specyfikacja nie czyni z niego gotowego multi-tenant control plane [S23]. Dots są punktem odniesienia dla ciągłości pracy; nie zakładamy niepotwierdzonego publicznego API sterowania osobistym dotem. Osobny interfejs Workspace Agents ma inne możliwości i ograniczenia [S24][S25].

## Źródła zewnętrzne

Źródła wspierają konkretne fakty oznaczone wyżej. Nazwy encji, stany, budżety startowe, UX i reguły Fluxa są propozycją autorską. Wszystkie poniższe strony sprawdzono 2026-09-30; nie jest to gwarancja niezmienności przyszłych warunków.

- [S1] Anthropic, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- [S2] Anthropic, Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- [S3] OpenAI, ChatGPT plan usage — Overview: https://developers.openai.com/siwc/token-sharing-open-source
- [S4] OpenAI, Preview limitations: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- [S5] OpenAI, Codex app-server: https://developers.openai.com/codex/app-server/
- [S6] Anthropic, Run Claude Code programmatically: https://code.claude.com/docs/en/headless
- [S7] Hermes, Tools & toolsets: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/
- [S8] OpenClaw, Gateway security: https://docs.openclaw.ai/gateway/security
- [S9] OpenClaw, A2A: https://docs.openclaw.ai/channels/a2a
- [S10] Model Context Protocol, Tasks: https://modelcontextprotocol.io/extensions/tasks/overview
- [S11] OpenAI, Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- [S12] Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [S13] GitHub, Authenticating as an installation: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- [S14] GitHub, Webhooks best practices: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- [S15] Git, git-worktree: https://git-scm.com/docs/git-worktree
- [S16] GitHub, Approving a pull request with required reviews: https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews
- [S17] GitHub, About protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- [S18] GitHub, Managing a merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- [S19] Docker, Engine security: https://docs.docker.com/engine/security/
- [S20] Playwright, Trace viewer: https://playwright.dev/docs/trace-viewer
- [S21] GitHub, Secure use reference: https://docs.github.com/en/actions/reference/security/secure-use
- [S22] Anthropic, Building multi-agent systems — when and how to use them (2026-01-23): https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- [S23] OpenAI Symphony specification: https://github.com/openai/symphony/blob/main/SPEC.md
- [S24] OpenAI, Getting started with your dot: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- [S25] OpenAI, Trigger workspace agent runs: https://learn.chatgpt.com/workspace-agents/trigger-runs
