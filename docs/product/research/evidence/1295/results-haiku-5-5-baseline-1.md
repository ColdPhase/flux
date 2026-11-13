# Answer accuracy (#1295): claude-haiku-5-5, variant main, haiku-5-5-baseline-1

Flux 64e4ff4ce (main; harness a222fe95b) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2567 agent + $0.0084 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.8 | 12 / 0 / 2 / 1 | 1 | 0.867 | 0.867 | 0.867 | 0 (0) | - | 35784 | 729 | 0.00394 | 6.1 / 11.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 0.5 (0.5) | - | 25295 | 411 | 0.00273 | 5 / 5 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (1) | - | 37193 | 632 | 0.00404 | 6.1 / 11.1 |
| file | 6 | 0 | 0 / 0 / 1 / 5 | 0 | 0 | 1 | 0.167 | 0 (1) | - | 52577 | 1063 | 0.00579 | 10.1 / 10.1 |
| task_decision_map | 7 | 0.857 | 6 / 0 / 1 / 0 | 0 | 0.857 | 1 | 0.857 | 0.286 (0.714) | - | 26111 | 552 | 0.00289 | 4.1 / 11.1 |
| two_source | 7 | 0.786 | 5 / 1 / 1 / 0 | 1 | 0.714 | 1 | 0.571 | 0 (0.714) | - | 47903 | 1074 | 0.00533 | 8.1 / 11.1 |
| relative_date | 10 | 0.8 | 8 / 0 / 2 / 0 | 0 | 0.875 | 0.8 | 0.875 | 0 (0) | 0.8 | 31348 | 1015 | 0.00364 | 8.1 / 10.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 41053 | 691 | 0.00445 | 7.1 / 10.1 |
| **all** | 62 | 0.782 | 48 / 1 / 7 / 6 | 2 | 0.774 | 0.909 | 0.755 | 0.055 (0.455) | 0.8 | 37408 | 799 | 0.00414 | 7.1 / 11.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski podał go w wątku Czujniki 14 kwietnia 2026 |
| old02 | old_messages | dont_know | false | search search search search search | I couldn't find a battery-life figure for a station measuring every ten minutes in Flux. The team has repeated |
| old03 | old_messages | correct | true | search search read_around | Najmocniejszy wynik w Flux to offset **+0,8°C** po kalibracji w komorze klimatycznej, dla serii z lutego. Zapi |
| old04 | old_messages | correct | true | search search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około **2,7 km**. Zmierzył to Piotr  |
| old05 | old_messages | correct | true | search search search search search search read_around | The fund is Black Pine, and in your message of 2 October 2026 in the Zarząd space, you wrote that it wanted to |
| old06 | old_messages | correct | true | search search search search list_decisions read_around read_around | Według Flux płytki montuje od czerwca Eurocircuits. Decyzję zapisała Sarah Mitchell 27 maja w wątku „Dostawy i |
| old07 | old_messages | correct | true | search search search | Według Flux ostatni zapisany stan to **12 kompletnych stacji** w magazynie w Pruszczu, z końca września (wpis  |
| old08 | old_messages | correct | true | search search search search read_around search | The team picked **Payload** as the CMS for the website, according to Jonas Berg in the Website relaunch space  |
| old09 | old_messages | correct | true | search search | Według Flux umowa z Gdańskiem przewiduje **karę umowną 0,2% za każdy dzień zwłoki** w montażu. Podaje to Twoja |
| old10 | old_messages | correct | true | search search search read_around | Na północnych dachach Piotr Zieliński napisał w wątku Czujników 15 lipca 2026, że panel 6 W wystarcza do całor |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, from 1 January. This is from your message in the Zarząd space on 12 Septemb |
| old12 | old_messages | wrong (input_too_large) | false | search search search search search get_conversation search search search search |  |
| old13 | old_messages | wrong | true | search search search search read_around | Nie znalazłem w Flux informacji o dyżurze telefonicznym w przerwie wakacyjnej. Najbliższa wzmianka to wiadomoś |
| old14 | old_messages | correct | true | search search search | Według Flux wydania firmware zatwierdza Marta Wiśniewska. Ada napisała to w Czujnikach 15 października 2026: „ |
| old15 | old_messages | correct | true | search search | Flux has one number for her: **58 323 11 47**. It is listed as "inż. Halina Kurek" (spelled *Kurek*, not *Kurr |
| win01 | recent | correct | true | search search | Stand-up is at 9:30, but not today. Ada Nowak's message of 9 November says it moves to 9:30 on Tuesdays and Th |
| win02 | recent | correct | true | - | The stations restart roughly every 49.7 days because the `millis()` counter overflows. Jonas Berg found the ca |
| wiki01 | wiki | correct | true | search search get_doc | Klient ma **30 dni** od dostawy na zgłoszenie zwrotu stacji. Wynika to z wiki „Procedura zwrotów (RMA)” w prze |
| wiki02 | wiki | correct | true | search search get_doc | Our core hours are 10:00 to 14:00, and outside them you can work when it suits you. This comes from the wiki p |
| wiki03 | wiki | correct | true | search search search search search search search search get_doc | Według wiki Czujniki test wygrzewania (soak test) trwa **72 godziny** na 20 stacjach w stojaku testowym, zanim |
| wiki04 | wiki | correct | true | search search get_doc | Transport jest gratis od 20 sztuk, według wiki "Cennik i rabaty 2027" w przestrzeni Dostawy i logistyka (autor |
| wiki05 | wiki | correct | true | search search | According to the wiki page "Montaż na dachu: BHP" in the Klient: Miasto Gdańsk space, roof installations must  |
| wiki06 | wiki | correct | true | search search search search | Na stronie nagłówki są ustawione czcionką **Fraunces**, a tekst główny czcionką **Inter**. Wynika to z wiki „B |
| wiki07 | wiki | correct | true | search search search | A failure reported by Gdańsk must get a response within **48 hours**, according to the wiki page "Gdańsk: SLA  |
| wiki08 | wiki | correct | true | search search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu. Tak stoi na wiki Firmy w stronie „Urlopy” (w F |
| file01 | file | wrong | false | search search read_around search search | Nie znalazłem ceny obudowy w ofercie Plastmetu w tekście Flux. Oferta jest załącznikiem `Oferta_Plastmet_obudo |
| file02 | file | dont_know | false | search search search search read_around search | I couldn't find the cause in Flux. The post-mortem is attached to Piotr Zieliński's message in the Czujniki sp |
| file03 | file | dont_know | false | search search read_around search list_materials | Nie mogę odczytać wartości z pliku. W Flux znalazłem plik **pomiary_ST-0417.csv** (30 wierszy), który Tomasz W |
| file04 | file | dont_know | false | search search read_around search search search | I couldn't find the penalty for the NDA with Sopot in Flux. The NDA was signed on 22 September 2026 and the fi |
| file05 | file | dont_know | false | search search read_around search search search read_around | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Raport z Gliwic (plik EMC_report_Gliwice.pdf, j |
| file06 | file | dont_know | false | search search search search read_around search search | I couldn't find station ST-0433 in Flux, so I can't say where it's installed. Searches for "ST-0433", "0433" a |
| tdm01 | task_decision_map | wrong | false | search search search get_work search read_around read_around | Nie znalazłem w Flux zamówienia anten przypisanego konkretnie do Przymorza. Jest tylko zadanie #1 „Wymiana ant |
| tdm02 | task_decision_map | correct | true | search search | Phoenix Testlab quoted 18,400 EUR for the RED tests, with six weeks from sample delivery. Jonas Berg posted th |
| tdm03 | task_decision_map | correct | true | search search search | Według Flux użyjecie **Better Stack**. Sarah Mitchell napisała 29 października w Website relaunch: "We'll go w |
| tdm04 | task_decision_map | correct | true | search search | The warranty for municipal customers is **36 months**. The accepted decision "Gwarancja 36 miesięcy dla klient |
| tdm05 | task_decision_map | correct | true | search search | W rewizji D złączem serwisowym ma być **USB-C**, a jedynym portem serwisowym będzie właśnie USB-C. Decyzja „US |
| tdm06 | task_decision_map | correct | true | search search | Według Twojej myśli na mapie w przestrzeni Czujniki abonament na dane kosztowałby **9 zł miesięcznie za stację |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | The "Website ideas" map in the Website relaunch space has a card that says the live map of every public statio |
| two01 | two_source | correct | true | search search get_doc read_around | Według Flux samorząd zapłaci około **1 096,50 zł netto za stację**, czyli około **65 790 zł netto** za 60 sztu |
| two02 | two_source | correct | true | search search get_doc search search search search list_decisions | **Marta Wiśniewska** approves firmware releases now. Ada announced this in the Czujniki conversation on 15 Oct |
| two03 | two_source | correct | true | search search get_doc search list_conversations | Według wiki "Gdańsk: SLA i kontakty" (w przestrzeni Klient: Miasto Gdańsk) na awarię zgłoszoną przez miasto mu |
| two04 | two_source | partial | false | search search search search | I couldn't find a start date for a new embedded developer in Flux. The most recent recruiting messages, from N |
| two05 | two_source | correct | true | search search search get_decision get_doc | - **Gwarancja:** Zaakceptowana decyzja z dzisiaj mówi o co najmniej **36 miesięcach gwarancji** dla klientów s |
| two06 | two_source | correct | true | search search search get_work get_task_discussion search summarize search | Miasto zgłosiło 27 października, że **4 stacje na Przymorzu** pokazują temperaturę o 5 stopni za wysoką. Zespó |
| two07 | two_source | wrong (input_too_large) | false | search search read_around search search search search search |  |
| rel01 | relative_date | correct | true | search search search read_around | Około półtora miesiąca temu, 30 września, Bogdan Kowalski w rozmowie Zarządu napisał: „Ustaliliśmy budżet mark |
| rel02 | relative_date | wrong | false | search search search search search search | I couldn't find anything Maurycy said about the supplier in early October. Searches for his name, alone and wi |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu (2–8 listopada) w przestrzeni działo się głównie następujące: - **Wysyłki do klientów:** za |
| rel04 | relative_date | correct | true | search search | The message from about two months ago is from Ola Lewandowska on 2026-09-13 in the "Dostawy i logistyka" space |
| rel05 | relative_date | correct | true | search search search | W weekend 7–8 listopada dyżur miał Jonas. Piotr Zieliński napisał w wątku Czujniki w piątek 6 listopada, że te |
| rel06 | relative_date | correct | true | search search | In early October, Piotr reported two main things in the Czujniki space: - **Firmware 2.6** (3 Oct) passed test |
| rel07 | relative_date | correct | true | search search search read_around | W październiku wysłaliśmy do Gdańska **18 stacji**. Ola Lewandowska napisała 14 października: „Wysłaliśmy do G |
| rel08 | relative_date | wrong | - | summarize | Last week was busy but mostly unresolved. The recurring problems were staging going down, contact-form spam, s |
| rel09 | relative_date | correct | true | search search summarize | Około 3 tygodnie temu (20–23 października) Sarah Mitchell w wątku **Website relaunch** napisała o stronach m.i |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 15 października 2026 w space Dostawy i logistyka, że fracht morski z Shenzhen wynosi 2 950 U |
| none01 | no_answer | correct | - | search search search search | Nie znalazłam w Flux NIP-u firmy Plastmet. Wyszukiwanie po „NIP” i „Plastmet” zwraca tylko wzmianki o fakturac |
| none02 | no_answer | correct | - | search search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. I searched for Wi-Fi, wifi, network, internet a |
| none03 | no_answer | correct | - | search search search search search | Nie znalazłem w Flux żadnej informacji o wydatkach na reklamy na LinkedIn w październiku. Przeszukałem wiadomo |
| none04 | no_answer | correct | - | search search search search get_doc | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for his name and for "telefon" or "numer ko |
| none05 | no_answer | correct | - | search search search search search search search list_contexts search search | Nie znalazłem w Flux żadnej wzmianki o umowie z Krakowem na stacje. Szukałem po „Kraków”, „Krakowem”, „Krakow” |
| none06 | no_answer | correct | - | search search search search search search | I couldn't find any mention of an ATEX certificate or its certification body in Flux. I searched in English an |
| none07 | no_answer | correct | - | search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Wyszukiwanie po „Eurocircuits konto bankowe”, „IBAN” |
