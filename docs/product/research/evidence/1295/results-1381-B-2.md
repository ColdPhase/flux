# Answer accuracy (#1295): claude-haiku-5-5, variant wiki-index, 1381-B-2

Flux 58c10e9e4 (main; harness 7b31d081a) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2324 agent + $0.0084 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.867 | 12 / 2 / 0 / 1 | 0 | 0.933 | 0.933 | 0.933 | 0.933 (0.933) | - | 30232 | 617 | 0.00333 | 6.1 / 8.2 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 1 (1) | - | 26600 | 400 | 0.00286 | 5.1 / 5.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 27757 | 523 | 0.00304 | 5.1 / 6.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0 | 0 (0.833) | - | 52840 | 960 | 0.00576 | 10.1 / 11.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (0.857) | - | 24061 | 510 | 0.00266 | 5.1 / 8.1 |
| two_source | 7 | 0.571 | 2 / 4 / 1 / 0 | 1 | 0.429 | 1 | 0.429 | 0.857 (0.857) | - | 45881 | 977 | 0.00508 | 8.1 / 11.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0.7 (0.7) | 0.6 | 27453 | 746 | 0.00312 | 6 / 10.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 42700 | 726 | 0.00463 | 7.1 / 9.1 |
| **all** | 62 | 0.806 | 47 / 6 / 1 / 8 | 1 | 0.774 | 0.927 | 0.755 | 0.764 (0.873) | 0.6 | 34013 | 693 | 0.00375 | 6.1 / 10.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał o nim 14 kwietnia 2026 w wątku Czu |
| old02 | old_messages | dont_know | false | search search search search | I couldn't find a battery-life figure for a station measuring every ten minutes in Flux. Several people asked  |
| old03 | old_messages | correct | true | search search | Według Flux po kalibracji w komorze klimatycznej wyszedł stały offset **+0,8 °C** dla serii z lutego. Marta Wi |
| old04 | old_messages | correct | true | search search | Bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej miała zasięg około 2,7 km. Piotr Zieliński zmierzył to row |
| old05 | old_messages | correct | true | search search search | The fund is Black Pine, and it offers 2.5 million zł for a 15% stake in the company. You wrote that on 2 Octob |
| old06 | old_messages | correct | true | search search search search search | Eurocircuits assembles your boards now. Sarah Mitchell's decision of 27 May 2026 moved PCB assembly from Satel |
| old07 | old_messages | correct | true | search search list_contexts | Według Flux w magazynie w Pruszczu było **12 kompletnych stacji** na koniec września, ale to najnowsza liczba, |
| old08 | old_messages | correct | true | search list_contexts search search search read_around | The site's CMS appears to be Payload. Jonas Berg wrote on 14 May 2026 that the team picked Payload over Strapi |
| old09 | old_messages | partial | true | search search | W Flux są dwie różne kwoty, więc nie ma jednej jednoznacznej odpowiedzi. - Wiadomość Ady z 16 czerwca mówi, że |
| old10 | old_messages | correct | true | search search | Według wiadomości Piotra Zielińskiego z 15 lipca na kanale Czujniki, panel 6 W wystarcza do całorocznej pracy  |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, starting 1 January (2027, judging by the date of the message). You wrote th |
| old12 | old_messages | correct | true | search search search search search read_around | The city reported that **4 stations in Przymorze** show temperatures 5 degrees too high. The suspected cause i |
| old13 | old_messages | partial | true | search search search search search | Nie znalazłem w Flux informacji o przerwie wakacyjnej w listopadzie ani o osobie pod telefonem na ten czas. Na |
| old14 | old_messages | correct | true | search search search search | Według wiadomości, którą Ada napisała 15 października w przestrzeni Czujniki, wydania firmware zatwierdza od t |
| old15 | old_messages | correct | true | search search | Flux has one number for her: **58 323 11 47**, listed as the city contact "inż. Halina Kurek" in the Gdańsk cl |
| win01 | recent | correct | true | search search | Dzisiaj, w piątek, stand-up się nie odbywa, bo jest we wtorki i czwartki. Od przyszłego tygodnia przenosicie g |
| win02 | recent | correct | true | - | The stations restart about every 49.7 days because the `millis()` counter overflows, so the units reboot [1].  |
| wiki01 | wiki | correct | true | search search | Klient ma **30 dni od dostawy** na zgłoszenie zwrotu stacji, według Wiki „Procedura zwrotów (RMA)” w przestrze |
| wiki02 | wiki | correct | true | search search get_doc | Our core working hours are 10:00 to 14:00. Outside them, you can work when it suits you. This comes from the W |
| wiki03 | wiki | correct | true | search search | Według checklisty wydania przed pierwszą falą aktualizacji obowiązuje test wygrzewania (soak) trwający **72 go |
| wiki04 | wiki | correct | true | search search | Według cennika "Cennik i rabaty 2027" transport jest gratis od 20 sztuk [1]. Ten zapis nie wskazuje osobno sta |
| wiki05 | wiki | correct | true | search search get_doc | Roof installations are not allowed in wind above 12 m/s, according to the safety page "Montaż na dachu: BHP" i |
| wiki06 | wiki | correct | true | search search search search | Na nagłówkach używamy kroju **Fraunces**, a tekst główny jest w kroju Inter. Wynika to ze strony "Brand guidel |
| wiki07 | wiki | correct | true | search search get_doc | The response time for a failure reported by Gdańsk is **48 hours**, according to the wiki page "Gdańsk: SLA i  |
| wiki08 | wiki | correct | true | search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu, czyli z co najmniej dwutygodniowym wyprzedzeni |
| file01 | file | dont_know | false | search search read_around search search | Nie znalazłem ceny obudowy w tekście Flux. Oferta Plastmetu na obudowy jest w załączniku PDF „Oferta_Plastmet_ |
| file02 | file | dont_know | false | search search search search read_around search list_materials | I can't tell you the cause. The post-mortem is attached to Piotr Zieliński's message in the Czujniki space on  |
| file03 | file | dont_know | false | search search read_around list_materials search search | Nie znalazłam tej wartości w Flux. Plik z pomiarami to `pomiary_ST-0417.csv` (30 wierszy), wysłany przez Tomas |
| file04 | file | dont_know | false | search search search search read_around | I couldn't find the penalty in Flux. The NDA with Sopot was signed on 22 September 2026, and Ada Nowak posted  |
| file05 | file | dont_know | false | search search read_around search search search | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Raport z badań EMC z Gliwic jest załącznikiem E |
| file06 | file | dont_know | false | search list_contexts search search | I couldn't find where station ST-0433 is installed. Flux has no record of that ID, and searching for "0433" re |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion | Zamówiono **25 anten Taoglas FXP290**, z dostawą 2 grudnia. Zamówienie zapisała Ola Lewandowska w wątku zadani |
| tdm02 | task_decision_map | correct | true | search search | Phoenix Testlab quoted **18,400 EUR** for the RED tests, with six weeks from sample delivery. Jonas Berg poste |
| tdm03 | task_decision_map | correct | true | search search | Według wiadomości Sarah Mitchell z 29 października 2026 r. strona statusu będzie na **Better Stack**, pod adre |
| tdm04 | task_decision_map | correct | true | search search | The warranty for municipal customers is **36 months**. The accepted decision "Gwarancja 36 miesięcy dla klient |
| tdm05 | task_decision_map | correct | true | search search get_decision | W rewizji D serwisowym złączem będzie USB-C, a micro-USB zostanie wycofane. Decyzja „USB-C as the only service |
| tdm06 | task_decision_map | correct | true | search search get_map | Według mapy "Pomysły na 2027" w przestrzeni Czujniki abonament na dane miałby kosztować 9 zł miesięcznie za st |
| tdm07 | task_decision_map | correct | true | search list_maps | The ideas map in Website relaunch says the live map of every public station is **refreshed every 10 minutes**. |
| two01 | two_source | correct | true | search search get_doc search | Przy 60 sztukach samorząd zapłaci w przybliżeniu **1 096,50 zł netto za stację**. To wynik 1 290 zł pomniejszo |
| two02 | two_source | partial | true | search search get_doc search list_decisions search | The soak test is 72 hours, but I could not find who approves firmware releases now. The "Firmware release chec |
| two03 | two_source | partial | false | search search get_doc | Na awarię zgłoszoną przez miasto Gdańsk reagujecie w ciągu **48 godzin**, a wymiana stacji zajmuje 5 dni roboc |
| two04 | two_source | partial | false | search search search search | I couldn't find a start date for the new embedded developer in Flux. The recruiting channel only shows intervi |
| two05 | two_source | correct | true | search search get_doc get_decision | Gwarancja dla Gdańska to **36 miesięcy**, bo przetargi samorządowe wymagają co najmniej tyle; rezerwa na napra |
| two06 | two_source | wrong (input_too_large) | false | search search get_work search read_around read_around get_task_discussion search |  |
| two07 | two_source | partial | false | search search search search | I couldn't find the unit price of one Plastmet enclosure in Flux. Bogdan Kowalski posted a Plastmet offer for  |
| rel01 | relative_date | correct | true | search search search read_around | Około 30 września 2026 Bogdan Kowalski w rozmowie Zarządu napisał: „Ustaliliśmy budżet marketingowy na pierwsz |
| rel02 | relative_date | dont_know | false | search search search read_around search search | I couldn't find anything Maurycy said about a supplier in early October. Flux has no message, task or wiki pag |
| rel03 | relative_date | correct | - | summarize | Ostatni tydzień (poniedziałek 2 listopada do niedzieli 8 listopada) w „Dostawy i logistyka” wyglądał tak: - ** |
| rel04 | relative_date | correct | true | search search search | The message is from Ola Lewandowska on 13 September 2026 in Dostawy i logistyka. It gives invoice **FV/0915/20 |
| rel05 | relative_date | correct | true | search search search | Według Flux w weekend 7–8 listopada dyżur miał Jonas. Piotr Zieliński napisał 6 listopada w Czujnikach: „W ten |
| rel06 | relative_date | correct | true | search search | Piotr Zieliński reported on 3 October 2026 that **firmware 2.6 passed testing** on 20 stations, with zero rest |
| rel07 | relative_date | correct | true | search search search | W październiku wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała 14 października: "Wysłaliśmy do  |
| rel08 | relative_date | correct | - | summarize | Last week (Mon 2 to Sun 8 November) the thread had 30 messages, mostly short status updates. Jonas Berg and Sa |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell podała 23 października 2026 w Website relaunch, że nowa strona przeszła audyt dostępności z wyn |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 15 października 2026 frachtu morskiego z Shenzhen w wysokości **2 950 USD za kontener 20'**, |
| none01 | no_answer | correct | - | search search search | Nie znalazłem w Flux NIP-u firmy Plastmet. Szukałem po słowach „NIP” i „Plastmet” we wszystkich przestrzeniach |
| none02 | no_answer | correct | - | search search search search search search | I couldn't find the Wi-Fi password in Flux. I searched messages, Wiki pages and tasks in English and Polish fo |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux kwoty wydatków na reklamy LinkedIn za październik. Szukałem po polsku i po angielsku, ale |
| none04 | no_answer | correct | - | search search search | I couldn't find a phone number for Tomasz Wójcik in Flux. A search for his name returns nothing, and searches  |
| none05 | no_answer | correct | - | search search search search search search | Nie znalazłem w Flux żadnej wzmianki o umowie z Krakowem na stacje, ani podpisanej, ani w negocjacjach. Wyszuk |
| none06 | no_answer | correct | - | search search search search search | I couldn't find any record of an ATEX certificate in the spaces I can read. Searches for "ATEX", "explosion pr |
| none07 | no_answer | correct | - | search search search search search | W Flux nie znalazłam numeru konta bankowego Eurocircuits. Przeszukałam wiadomości, Wiki i zadania pod kątem na |
