# Answer accuracy (#1295): claude-haiku-5-5, variant main, haiku-5-5-baseline-2

Flux 64e4ff4ce (main; harness a222fe95b) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2554 agent + $0.0082 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.833 | 12 / 1 / 2 / 0 | 1 | 0.867 | 0.867 | 0.867 | 0 (0) | - | 36147 | 653 | 0.00394 | 6.1 / 9.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 0.5 (0.5) | - | 25466 | 576 | 0.00283 | 7.1 / 7.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (1) | - | 36379 | 648 | 0.00396 | 6.1 / 9.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0.167 | 0 (0.833) | - | 46685 | 873 | 0.00511 | 8.1 / 11.1 |
| task_decision_map | 7 | 0.857 | 6 / 0 / 1 / 0 | 0 | 0.857 | 1 | 0.857 | 0.286 (0.857) | - | 24150 | 537 | 0.00268 | 5.1 / 8.1 |
| two_source | 7 | 0.5 | 2 / 3 / 2 / 0 | 2 | 0.571 | 0.857 | 0.857 | 0 (0.714) | - | 62185 | 1157 | 0.0068 | 10.1 / 11.2 |
| relative_date | 10 | 0.65 | 6 / 1 / 2 / 1 | 0 | 0.75 | 0.7 | 0.875 | 0 (0) | 0.8 | 26713 | 830 | 0.00309 | 7.1 / 10.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 40896 | 693 | 0.00444 | 7.1 / 9.2 |
| **all** | 62 | 0.734 | 43 / 5 / 7 / 7 | 3 | 0.736 | 0.855 | 0.792 | 0.055 (0.455) | 0.8 | 37452 | 748 | 0.00412 | 7.1 / 10.2 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał o nim w przestrzeni Czujniki 14 kw |
| old02 | old_messages | wrong | false | search search search search search | Flux doesn't have a battery-life figure for a station measuring every ten minutes. Nobody has recorded a measu |
| old03 | old_messages | correct | true | search search read_around | Według Flux po kalibracji w komorze klimatycznej wyszedł stały offset **+0,8°C** dla serii z lutego. Zapisała  |
| old04 | old_messages | correct | true | search search search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Piotr Zieliński podał  |
| old05 | old_messages | correct | true | search search search | The fund Black Pine offers 2.5 million zł for a 15% stake. You wrote this in the Zarząd space on 2 October 202 |
| old06 | old_messages | partial | true | search search search read_around search search | Based on Flux, the switch to Eurocircuits was decided on 27 May by Sarah Mitchell: PCB assembly moved from Sat |
| old07 | old_messages | correct | true | search search search | Nie da się tego pewnie ustalić z Flux. Ostatnia wprost podana liczba to **12 kompletnych stacji** na koniec wr |
| old08 | old_messages | correct | true | search search search search read_around | The site's CMS is **Payload**, not Strapi. Jonas Berg wrote in the Website relaunch space on 14 May 2026 that  |
| old09 | old_messages | correct | true | search search | Według wiadomości Ady z 16 czerwca 2026 w space "Klient: Miasto Gdańsk" kara umowna wynosi **0,2% za każdy dzi |
| old10 | old_messages | correct | true | search search search read_around | Według Flux na północnych dachach potrzebny jest panel **10 W**. Panel 6 W wystarcza do całorocznej pracy tylk |
| old11 | old_messages | correct | true | search search search search | The office is moving to Garbary 8, from 1 January. That comes from your message in the Zarząd space on 12 Sept |
| old12 | old_messages | wrong (input_too_large) | false | search search search search search search search get_conversation |  |
| old13 | old_messages | correct | true | search search search search | Nie znalazłem w Flux dyżuru na przerwę wakacyjną. Najbliższe wpisy to: w Czujnikach Jonas miał dyżur i telefon |
| old14 | old_messages | correct | true | search search search | Według Flux wydania firmware zatwierdza od 15 października 2026 Marta Wiśniewska. Ada Nowak napisała to w rozm |
| old15 | old_messages | correct | true | search search | Według Flux telefon do inż. Haliny Kurek z Miasta Gdańsk to **58 323 11 47**. Podała go Ada Nowak w wiadomości |
| win01 | recent | correct | true | search search | Stand-up is not scheduled for today: it runs on Tuesdays and Thursdays. Ada announced on 9 November that from  |
| win02 | recent | correct | true | - | Jonas Berg found the cause: the units reboot every 49.7 days because the `millis()` counter overflows, and the |
| wiki01 | wiki | correct | true | search search | Według wiki **„Procedura zwrotów (RMA)”** w przestrzeni Czujniki klient ma **30 dni od dostawy** na zgłoszenie |
| wiki02 | wiki | correct | true | search search get_doc | Our core hours are 10:00 to 14:00, according to the wiki page "Onboarding: the first week" in the Firma space  |
| wiki03 | wiki | correct | true | search search search search search search get_doc | Test wygrzewania (soak test) trwa według wiki **Firmware release checklist** w przestrzeni Czujniki **72 godzi |
| wiki04 | wiki | correct | true | search search search get_doc | Transport is free from 20 stations (20 sztuk) according to the wiki page "Cennik i rabaty 2027" in the Dostawy |
| wiki05 | wiki | correct | true | search search get_doc | According to the wiki page "Montaż na dachu: BHP" in the space "Klient: Miasto Gdańsk", roof installations mus |
| wiki06 | wiki | correct | true | search search search search search search search search search | Według wiki **Brand guidelines** w przestrzeni Website relaunch nagłówki są ustawione czcionką **Fraunces**, a |
| wiki07 | wiki | correct | true | search search | The response time for a failure reported by the city of Gdańsk is **48 hours**. This comes from the wiki page  |
| wiki08 | wiki | correct | true | search search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu. Tak stoi na wiki w przestrzeni Firma, na stron |
| file01 | file | dont_know | false | search search read_around search | Nie znalazłem ceny obudowy od Plastmetu w tekście Flux. Oferta jest w załączniku PDF „Oferta_Plastmet_obudowy. |
| file02 | file | dont_know | false | search search search search read_around search list_materials | I couldn't find the cause. The post-mortem is attached to a message from Piotr Zieliński in the Czujniki space |
| file03 | file | dont_know | false | search search read_around search | Nie znalazłem w Flux wartości maksymalnej. Plik **pomiary_ST-0417.csv** (30 wierszy) jest załączony do wiadomo |
| file04 | file | dont_know | false | search search read_around search | I couldn't find the penalty amount in Flux. The NDA with Sopot was signed on 2026-09-22 in the Zarząd space, a |
| file05 | file | dont_know | false | search search read_around search search read_around | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Raport z Gliwic jest załącznikiem `EMC_report_G |
| file06 | file | dont_know | false | search search search search search | I couldn't find station ST-0433 in Flux. Searches for "ST-0433" and "0433" in messages, wiki pages, tasks and  |
| tdm01 | task_decision_map | wrong | false | search search search get_work search | Nie znalazłem w Flux zamówienia anten konkretnie na wymianę na Przymorzu, ani ich liczby i modelu. Jest tylko  |
| tdm02 | task_decision_map | correct | true | search search | Phoenix Testlab quoted **18,400 EUR** for the RED tests, with six weeks from sample delivery. Jonas Berg poste |
| tdm03 | task_decision_map | correct | true | search search search | Według Flux strona statusu będzie działać w **Better Stack**. Sarah Mitchell napisała to 29 października w roz |
| tdm04 | task_decision_map | correct | true | search search | The warranty for municipal customers is **36 months**. This is the accepted decision "Gwarancja 36 miesięcy dl |
| tdm05 | task_decision_map | correct | true | search search search get_decision | W rewizji D złączem serwisowym ma być USB-C, a jedynym portem serwisowym będzie właśnie USB-C. Decyzja „USB-C  |
| tdm06 | task_decision_map | correct | true | search search | Na mapie pomysłów w przestrzeni **Czujniki** jest Twój zapis z dzisiaj (10:31): abonament na dane to **9 zł mi |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | On the "Website ideas" map in the Website relaunch space, the live map of stations is noted to refresh every 1 |
| two01 | two_source | correct | true | search search get_doc search | Według Flux samorząd zapłaciłby około **1 096,50 zł netto za stację**, czyli około **65 790 zł netto** za 60 s |
| two02 | two_source | partial | true | search search get_doc search search search | I couldn't find who approves firmware releases now. The new "Firmware release checklist" in Czujniki (written  |
| two03 | two_source | correct | true | search search search get_doc search | Zgłoszenia awarii od miasta obsługuje po stronie klienta inż. Halina Kurek, tel. 58 323 11 47. Ada, to dane z  |
| two04 | two_source | partial | false | search search search search get_conversation get_doc | I couldn't find a start date for a new embedded developer in Flux. The Rekrutacja space suggests the role is s |
| two05 | two_source | partial | true | search search search get_doc get_decision | Gwarancja dla samorządów, w tym Gdańska, to według zaakceptowanej decyzji z dzisiaj (#"Gwarancja 36 miesięcy d |
| two06 | two_source | wrong (input_too_large) | false | search search get_work search search get_conversation search search search |  |
| two07 | two_source | wrong (input_too_large) | false | search search search search read_around search search search list_materials search search search |  |
| rel01 | relative_date | correct | true | search search search read_around | Około 30 września 2026 Bogdan Kowalski napisał w przestrzeni **Zarząd**: „Ustaliliśmy budżet marketingowy na p |
| rel02 | relative_date | dont_know | false | search search read_around search | I couldn't find anything Maurycy said about the supplier in early October. Searching for his name returns no m |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu (2–8 listopada) w przestrzeni działo się głównie to: - **Inwentaryzacja:** kilka razy ogłas |
| rel04 | relative_date | correct | true | search search | The message is from Ola Lewandowska on 13 September 2026, in the conversation of "Dostawy i logistyka". It rea |
| rel05 | relative_date | correct | true | search search search read_around | W miniony weekend (7–8 listopada) dyżur w space Czujniki miał Jonas Berg. Wynika to z wiadomości Piotra Zieliń |
| rel06 | relative_date | partial | true | search search | In early October, Piotr reported three things in the Czujniki space: - **Oct 1:** He installed firmware 2.4.3  |
| rel07 | relative_date | correct | true | search search | W październiku wysłaliście do Gdańska **18 stacji**. Wynika to z wiadomości Oli Lewandowskiej z 14 październik |
| rel08 | relative_date | wrong | - | summarize | Last week (Nov 6–12) the Website relaunch space had 56 messages, mostly about page copy, performance and the c |
| rel09 | relative_date | wrong | false | search search | W Website relaunch, około 23 października Sarah nie napisała nic o stronie, co widzę w wynikach wyszukiwania.  |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał w połowie października (15 października, w wątku "Dostawy i logistyka") fracht morski z Shen |
| none01 | no_answer | correct | - | search search search search | Nie znalazłem w Flux NIP-u firmy Plastmet. Wyszukiwanie po „NIP” i „Plastmet” zwraca tylko wzmianki o fakturac |
| none02 | no_answer | correct | - | search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. Searches for "Wi-Fi", "wifi", "password" and "n |
| none03 | no_answer | correct | - | search search search search search search | Nie znalazłem w Flux żadnej informacji o wydatkach na reklamy LinkedIn w październiku. Przeszukałem wiadomości |
| none04 | no_answer | correct | - | search search search search search search | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for his name, "Wójcik" and "Tomek" return n |
| none05 | no_answer | correct | - | search search search search search search list_contexts search | Nie znalazłem w Flux żadnej wzmianki o umowie z Krakowem. Szukałem po „Kraków”, „Krakowie”, „Krakowa”, „Krakow |
| none06 | no_answer | correct | - | search search search search search | I couldn't find any mention of an ATEX certificate or its certification body in Flux. Searches in English and  |
| none07 | no_answer | correct | - | search search search search | Nie znalazłem numeru konta bankowego Eurocircuits we Flux. Wyszukiwanie po nazwie firmy, „IBAN" i „numer konta |
