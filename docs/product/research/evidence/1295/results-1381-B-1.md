# Answer accuracy (#1295): claude-haiku-5-5, variant wiki-index, 1381-B-1

Flux 58c10e9e4 (main; harness 7b31d081a) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2334 agent + $0.0083 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.867 | 13 / 0 / 1 / 1 | 1 | 0.867 | 0.867 | 0.867 | 0.867 (0.867) | - | 30533 | 599 | 0.00335 | 6.1 / 8.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 1 (1) | - | 26713 | 463 | 0.0029 | 6 / 6 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 23828 | 496 | 0.00263 | 5.1 / 6.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0 | 0 (0.833) | - | 52492 | 917 | 0.00571 | 8.1 / 10.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (0.857) | - | 23209 | 576 | 0.00261 | 5.1 / 8.1 |
| two_source | 7 | 0.786 | 5 / 1 / 1 / 0 | 1 | 0.714 | 1 | 0.571 | 0.857 (0.857) | - | 41750 | 989 | 0.00467 | 8.1 / 9.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0.7 (0.7) | 0.6 | 36036 | 934 | 0.00407 | 8.1 / 10.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 40403 | 603 | 0.00434 | 6.2 / 10.1 |
| **all** | 62 | 0.831 | 51 / 1 / 2 / 8 | 2 | 0.792 | 0.909 | 0.755 | 0.745 (0.855) | 0.6 | 34111 | 708 | 0.00377 | 6.1 / 9.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski zapisał go 14 kwietnia 2026 przy zamówieni |
| old02 | old_messages | dont_know | false | search search search search | I couldn't find a measured battery life for a station at a ten-minute interval in Flux. The recurring question |
| old03 | old_messages | correct | true | search search | Według Flux po kalibracji w komorze klimatycznej wyszedł stały offset **+0,8 °C** dla serii z lutego. Marta Wi |
| old04 | old_messages | correct | true | search search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Zmierzył to Piotr Ziel |
| old05 | old_messages | correct | true | search search search search search search | The fund is Black Pine. In your message of 2 October 2026, you wrote that it wants to invest 2.5 million zł fo |
| old06 | old_messages | correct | true | search search search | Płytki montuje teraz Eurocircuits. Decyzja z 27 maja 2026 mówi, że montaż PCB przechodzi z Satel-Tech na Euroc |
| old07 | old_messages | correct | true | search search search | Według ostatniego zapisu w Flux w magazynie w Pruszczu były **12 kompletnych stacji** na koniec września, obok |
| old08 | old_messages | correct | true | search search search search list_decisions read_around | The site uses **Payload** as its content management system, chosen over Strapi. Jonas Berg wrote on 14 May 202 |
| old09 | old_messages | correct | true | search search | Kara umowna w umowie z Gdańskiem to **0,2% za każdy dzień zwłoki** w montażu, według Twojej wiadomości z czerw |
| old10 | old_messages | correct | true | search search search search | Na północnych dachach potrzebny jest panel **10 W**. Piotr Zieliński napisał, że panel 6 W wystarcza do całoro |
| old11 | old_messages | correct | true | search search search search | The only mention I found is your message in the Zarząd space from 12 September 2026: the office move is to Gar |
| old12 | old_messages | wrong (input_too_large) | false | search search search search search search search search |  |
| old13 | old_messages | correct | true | search search search search | Nie znalazłem w Flux żadnej informacji o dyżurze podczas przerwy wakacyjnej w obecnym okresie. Najbliższe wpis |
| old14 | old_messages | correct | true | search search search | Według Flux wydania firmware zatwierdza od 15 października 2026 Marta Wiśniewska, a Jonas Berg zajmuje się chm |
| old15 | old_messages | correct | true | search search | Flux has one phone number for her: inż. Halina Kurek (spelled "Kurek" in Flux, not "Kurrek") is listed as the  |
| win01 | recent | correct | true | search search | Today is Friday, so there's no stand-up on the schedule. Ada's message says stand-up moves to 9:30 on Tuesdays |
| win02 | recent | correct | true | - | Jonas Berg found the cause: the units reboot every 49.7 days because the `millis()` counter overflows, and the |
| wiki01 | wiki | correct | true | search search | Według procedury zwrotów (RMA) klient ma **30 dni od dostawy** na zgłoszenie zwrotu stacji. Numer zgłoszenia m |
| wiki02 | wiki | correct | true | search search | Your core working hours are 10:00 to 14:00. Outside those hours, you can work when it suits you. This comes fr |
| wiki03 | wiki | correct | true | search search search | Test wygrzewania trwa **72 godzin** na 20 stacjach w stanowisku testowym, zanim ruszy pierwsza fala. Wynika to |
| wiki04 | wiki | correct | true | search search | Według cennika Flux transport jest gratis od 20 sztuk. Pochodzi to z dokumentu „Cennik i rabaty 2027” w przest |
| wiki05 | wiki | correct | true | search search get_doc | Roof installations are not allowed when the wind is above 12 m/s, according to the safety page "Montaż na dach |
| wiki06 | wiki | correct | true | search search search search | Nagłówki na stronie są ustawione czcionką **Fraunces**, a tekst główny jest w Inter. Tak stanowi strona Wiki „ |
| wiki07 | wiki | correct | true | search search | Flux says Gdańsk expects a response to a reported failure within **48 hours**. The SLA page also sets a penalt |
| wiki08 | wiki | correct | true | search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu, według strony Wiki „Urlopy” w przestrzeni Firm |
| file01 | file | dont_know | false | search search read_around search | Nie znalazłem ceny obudowy w tekście Flux. Oferta Plastmetu na obudowy jest w załączniku Oferta_Plastmet_obudo |
| file02 | file | dont_know | false | search search search search read_around search search | I found the post-mortem, but I can't see its cause. It is the file **postmortem-cloud-outage.md** (266 bytes), |
| file03 | file | dont_know | false | search search read_around search | Nie mogę odczytać wartości z pliku. Pomiary ze stacji ST-0417 są w załączniku `pomiary_ST-0417.csv` (30 wiersz |
| file04 | file | dont_know | false | search search read_around search | I couldn't find the penalty in Flux. The only trace of the Sopot NDA is Ada Nowak's message in the Zarząd spac |
| file05 | file | dont_know | false | search search read_around read_around search search search search | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Jest tam raport z badań EMC z Gliwic, ale to pl |
| file06 | file | dont_know | false | search list_contexts search search | I couldn't find station ST-0433 in Flux. Searching for "ST-0433" and "0433" across the spaces you can see retu |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion | Według wątku zadania #1 „Wymiana anten w stacjach na Przymorzu” zamówiono **25 anten Taoglas FXP290**, z dosta |
| tdm02 | task_decision_map | correct | true | search search | The lab quote was **18,400 EUR** from Phoenix Testlab for the RED tests, with six weeks from sample delivery.  |
| tdm03 | task_decision_map | correct | true | search search | Według Flux strona statusu ma działać w **Better Stack**, pod adresem status.zielonydach.eu jako CNAME. Tę dec |
| tdm04 | task_decision_map | correct | true | search search | The accepted decision "Gwarancja 36 miesięcy dla klientów samorządowych" sets the warranty for municipal custo |
| tdm05 | task_decision_map | correct | true | search search | W rewizji D złączem serwisowym będzie **USB-C**, jako jedyny port serwisowy. Decyzja jest zaakceptowana i ma u |
| tdm06 | task_decision_map | correct | true | search search get_map | Na mapie „Pomysły na 2027” w przestrzeni Czujniki jest Twoja karta: „Abonament na dane: 9 zł miesięcznie za st |
| tdm07 | task_decision_map | correct | true | search list_maps | According to a thought on the Website relaunch map, the live map of every public station refreshes every 10 mi |
| two01 | two_source | correct | true | search search get_doc read_around | Według Flux samorząd zapłaci około **1 096,50 zł netto** za jedną stację przy zamówieniu 60 sztuk w 2027 roku. |
| two02 | two_source | correct | true | search search get_doc search search | Marta Wiśniewska approves firmware releases now. Ada posted that change in the Czujniki space on 15 October: " |
| two03 | two_source | correct | true | search search get_doc search | Według Flux trzeba zareagować w ciągu **48 godzin** od zgłoszenia awarii przez miasto. Wymiana stacji zajmuje  |
| two04 | two_source | wrong (input_too_large) | false | search search search search get_doc search |  |
| two05 | two_source | correct | true | search search get_doc get_decision | Gwarancja dla Gdańska to **36 miesięcy**, zgodnie z zaakceptowaną decyzją dla klientów samorządowych, z rezerw |
| two06 | two_source | correct | true | search search get_work get_task_discussion | Miasto Gdańsk zgłosiło, że **4 stacje na Przymorzu** pokazują temperaturę o 5 stopni za wysoką. Podejrzewacie, |
| two07 | two_source | partial | false | search search search | I couldn't find the price of one Plastmet enclosure in Flux. Bogdan Kowalski's offer from Plastmet for the enc |
| rel01 | relative_date | correct | true | search search search read_around | Około 30 września 2026 Bogdan Kowalski napisał w rozmowie Zarządu: „Ustaliliśmy budżet marketingowy na pierwsz |
| rel02 | relative_date | dont_know | false | search search search search search | I couldn't find anything Maurycy said about the supplier in early October. Flux has no messages, tasks or wiki |
| rel03 | relative_date | correct | - | summarize search | W zeszłym tygodniu (2–8 listopada) w wątku było około 41 wiadomości. Najważniejsze: - **Wysyłki do klientów:** |
| rel04 | relative_date | correct | true | search search search search search | The message is from Ola Lewandowska on 13 September 2026, in the Dostawy i logistyka space. It gives invoice F |
| rel05 | relative_date | correct | true | search search search | W miniony weekend (7–8 listopada) dyżur miał Jonas. Piotr Zieliński napisał w projekcie Czujniki w piątek 6 li |
| rel06 | relative_date | correct | true | search search search summarize | According to Piotr Zieliński's message on 3 October 2026, firmware **2.6 passed testing** on 20 stations with  |
| rel07 | relative_date | correct | true | search search search summarize | W zeszłym miesiącu, czyli w październiku, wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała 14 pa |
| rel08 | relative_date | correct | - | summarize list_work | Last week (Mon 2 to Sun 8 November) the space had 30 messages, and the main themes were: - **Performance:** Li |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell napisała 23 października 2026 w projekcie Website relaunch, że nowa strona przeszła audyt dostę |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 15 października 2026 frachtu morskiego z Shenzhen na poziomie **2 950 USD za kontener 20'**, |
| none01 | no_answer | correct | - | search search search search | Nie znalazłem w Flux NIP-u firmy Plastmet. Wyszukiwanie po „NIP”, „NIP Plastmet” i po nazwie firmy w Wiki nic  |
| none02 | no_answer | correct | - | search search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. I searched messages, Wiki pages and tasks in En |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux kwoty wydatków na reklamy na LinkedIn za październik. Szukałem po słowach LinkedIn, rekla |
| none04 | no_answer | correct | - | search search search search | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for his name, for "Wójcik Tomasz" and for " |
| none05 | no_answer | correct | - | search search search search | Nie znalazłem w Flux niczego o umowie z Krakowem na stacje. Przeszukałem wiadomości, Wiki i zadania po słowach |
| none06 | no_answer | correct | - | search search search search search | I couldn't find any mention of an ATEX certificate or its certification body in Flux. Searches in English and  |
| none07 | no_answer | correct | - | search search search search | I couldn't find Eurocircuits' bank account number in Flux. I searched messages, Wiki pages and tasks in Polish |
