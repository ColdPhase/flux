# Answer accuracy (#1295): claude-haiku-5-5, variant main, 1381-A-1

Flux 58c10e9e4 (main; harness 7b31d081a) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2532 agent + $0.0086 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.733 | 11 / 0 / 1 / 3 | 0 | 0.8 | 0.8 | 0.8 | 0.8 (0.8) | - | 33796 | 635 | 0.0037 | 7.1 / 8.2 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 1 (1) | - | 26238 | 401 | 0.00282 | 6.1 / 6.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 29952 | 532 | 0.00326 | 5.2 / 8.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0 | 0 (0.833) | - | 56078 | 947 | 0.00608 | 9.1 / 12.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (0.857) | - | 25775 | 504 | 0.00283 | 5.1 / 7.1 |
| two_source | 7 | 0.714 | 3 / 4 / 0 / 0 | 0 | 0.429 | 1 | 0.571 | 1 (1) | - | 51068 | 1007 | 0.00561 | 8.1 / 10.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 1 / 0 | 0 | 0.875 | 0.9 | 0.875 | 0.7 (0.7) | 0.5 | 28264 | 705 | 0.00318 | 6.1 / 9.2 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 51219 | 790 | 0.00552 | 7.2 / 10.2 |
| **all** | 62 | 0.79 | 47 / 4 / 2 / 9 | 0 | 0.736 | 0.891 | 0.736 | 0.745 (0.855) | 0.5 | 37332 | 700 | 0.00408 | 7.1 / 10.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia na 400 sztuk SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski zapisał go w wątku Czujniki z |
| old02 | old_messages | dont_know | false | search search search | I can't find a measured battery life for a station reporting every ten minutes in Flux. The sleep current, whi |
| old03 | old_messages | correct | true | search search read_around | Z tego, co widzę w Flux, wyszedł stały offset **+0,8°C** po kalibracji w komorze klimatycznej. Dotyczy serii z |
| old04 | old_messages | correct | true | search search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Piotr Zieliński zmierz |
| old05 | old_messages | correct | true | search search search search search search read_around | The fund is Black Pine, and in Ada's message of 2 October 2026 it offered **2.5 million zł for 15% of the shar |
| old06 | old_messages | correct | true | search search search search | Płytki montuje teraz **Eurocircuits**. Sarah Mitchell ogłosiła tę decyzję 27 maja 2026: montaż przechodzi od S |
| old07 | old_messages | correct | true | search search search | Według ostatniego zapisu w Flux w magazynie w Pruszczu były na koniec września **12 kompletnych stacji** (210  |
| old08 | old_messages | dont_know | false | search search search search list_decisions list_docs | I couldn't find a record of which content management system was chosen, or why. I searched messages, the Wiki  |
| old09 | old_messages | correct | true | search search | Według wiadomości Ady z czerwca umowa z Gdańskiem przewiduje karę umowną **0,2% za każdy dzień zwłoki** przy m |
| old10 | old_messages | dont_know | false | search search search search | Nie znalazłem w Flux żadnego zalecenia dotyczącego panelu na północnych dachach. Najbliższe wyniki to wątki w  |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, from 1 January. You wrote this in the Zarząd space on 12 September 2026, an |
| old12 | old_messages | correct | true | search search search search search search read_around | The city is complaining about **4 stations in Przymorze**, which show a temperature 5 degrees too high. The su |
| old13 | old_messages | wrong | true | search search search | Nie znalazłem w Flux dyżuru na przerwę wakacyjną w listopadzie. Najbliższe wpisy dotyczą innych okresów: w Zar |
| old14 | old_messages | correct | true | search search search search read_around | Według Twojej wiadomości z 15 października w Czujnikach firmware zatwierdza Marta Wiśniewska, a Jonas Berg zaj |
| old15 | old_messages | correct | true | search search | Halina Kurek (pisane „Kurek”, nie „Kurrek”) ma w Flux numer **58 323 11 47**. Jest to kontakt po stronie miast |
| win01 | recent | correct | true | search search | Według wiadomości Ady z 9 listopada stand-up przenosi się na 9:30, we wtorki i czwartki, od następnego tygodni |
| win02 | recent | correct | true | - | The stations reboot about every 49.7 days because the `millis()` counter overflows, according to Jonas Berg's  |
| wiki01 | wiki | correct | true | search search | Klient ma **30 dni od dostawy** na zgłoszenie zwrotu stacji, według wiki „Procedura zwrotów (RMA)” w przestrze |
| wiki02 | wiki | correct | true | search search get_doc | Our core working hours are 10:00 to 14:00; outside them, you can work when it suits you. This is stated in the |
| wiki03 | wiki | correct | true | search search get_doc | Według Wiki w przestrzeni Czujniki test wygrzewania trwa 72 godziny: każde wydanie przechodzi go na 20 stacjac |
| wiki04 | wiki | correct | true | search search get_doc | Transport jest gratis od 20 sztuk, według wiki „Cennik i rabaty 2027” w space Dostawy i logistyka [1]. Strona  |
| wiki05 | wiki | correct | true | search search get_doc | Roof installations are not allowed when the wind is above 12 m/s, according to the safety page "Montaż na dach |
| wiki06 | wiki | correct | true | search search search search get_doc | Nagłówki na stronie są ustawione czcionką **Fraunces**, a tekst główny to **Inter**. Wynika to z wiki „Brand g |
| wiki07 | wiki | correct | true | search search | Gdańsk's SLA sets a **48-hour response time** for a failure the city reports, and station replacement within 5 |
| wiki08 | wiki | correct | true | search search | Według Wiki w przestrzeni Firma urlop zgłasza się **co najmniej 14 dni wcześniej** w Kadromierzu [1]. Nie spra |
| file01 | file | dont_know | false | search search read_around search search | Nie znalazłem ceny obudów Plastmetu w Flux. Jedyna oferta, jaką widzę, to plik „Oferta_Plastmet_obudowy.pdf” o |
| file02 | file | dont_know | false | search search search search read_around search list_materials | I could not find the cause in Flux. The post-mortem is an attachment, `postmortem-cloud-outage.md`, on a messa |
| file03 | file | dont_know | false | search search read_around list_materials search | Nie znalazłem tej wartości w Flux. Plik **pomiary_ST-0417.csv** (30 wierszy) został wysłany przez Tomasza Wójc |
| file04 | file | dont_know | false | search search read_around search search | I couldn't find the penalty amount in Flux. The only NDA with Sopot I found is a message you posted in Zarząd  |
| file05 | file | dont_know | false | search search read_around search search search read_around | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. W rozmowie o czujnikach jest raport z badań EMC |
| file06 | file | dont_know | false | search search search search | I could not find any record of station ST-0433 or its installation location in Flux. Searches for "ST-0433", " |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion | Według Flux zamówiono **25 anten Taoglas FXP290**, z dostawą 2 grudnia. Zamówienie zapisała Ola Lewandowska w  |
| tdm02 | task_decision_map | correct | true | search search | The lab quote was **18,400 EUR**. Phoenix Testlab quoted that amount for the RED tests, with six weeks from sa |
| tdm03 | task_decision_map | correct | true | search search | Strony statusu użyjemy **Better Stack**. Sarah Mitchell zapisała tę decyzję 29 października, z adresem **statu |
| tdm04 | task_decision_map | correct | true | search search get_decision | The warranty for municipal customers is at least 36 months. That is the accepted decision "Gwarancja 36 miesię |
| tdm05 | task_decision_map | correct | true | search search get_decision | W rewizji D złączem serwisowym będzie USB-C, a micro-USB zostaje wycofane. Decyzja jest zaakceptowana przez Jo |
| tdm06 | task_decision_map | correct | true | search search | Według notatki, którą dodałaś dziś o 11:46 na mapie w przestrzeni Czujniki, abonament na dane kosztuje 9 zł mi |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | On the "Website ideas" map in Website relaunch, the live map of every public station is set to refresh every 1 |
| two01 | two_source | correct | true | search search get_doc | Według Flux samorząd zapłaci około **1 096,50 zł netto za jedną stację** przy zamówieniu 60 sztuk w 2027 roku. |
| two02 | two_source | partial | false | search search get_doc search list_decisions | The soak test is 72 hours on 20 stations in the test rack before wave 1 [1]. Waves then go out at least 48 hou |
| two03 | two_source | partial | false | search search search get_doc search | Na awarię zgłoszoną przez miasto musicie zareagować w ciągu **48 godzin**, a wymiana stacji ma trwać 5 dni rob |
| two04 | two_source | partial | false | search search search search | I couldn't find a start date for the new embedded developer in Flux. The Rekrutacja messages still show the hi |
| two05 | two_source | correct | true | search search search get_doc get_decision | Gwarancja dla Gdańska to co najmniej 36 miesięcy, zgodnie z zaakceptowaną decyzją dla klientów samorządowych,  |
| two06 | two_source | correct | true | search search get_work read_around search get_task_discussion | Miasto zgłosiło, że 4 stacje na Przymorzu pokazują temperaturę o 5 stopni za wysoką, a podejrzewacie nagrzewan |
| two07 | two_source | partial | false | search search search search read_around | I couldn't find a per-unit price for a Plastmet enclosure in Flux. The only related item is a Plastmet offer f |
| rel01 | relative_date | correct | true | search search read_around | Około półtora miesiąca temu, 30 września, Bogdan Kowalski napisał w wątku Zarządu, że ustaliliście budżet mark |
| rel02 | relative_date | wrong | false | search search search read_around search | I can't find anything Maurycy said about the supplier in early October. Searches for his name, alone and with  |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu (2–8 listopada) w przestrzeni "Dostawy i logistyka" najwięcej działo się wokół wysyłek, cen |
| rel04 | relative_date | correct | true | search search | The message is from Ola Lewandowska on 13 September 2026 in the Dostawy i logistyka space. It gives invoice ** |
| rel05 | relative_date | correct | true | search search search | Według wpisu Piotra Zielińskiego z 6 listopada, w weekend 7–8 listopada dyżur w przestrzeni Czujniki miał Jona |
| rel06 | relative_date | correct | true | search search | According to Piotr Zieliński's message of 3 October 2026 in the Czujniki space, firmware **2.6** passed testin |
| rel07 | relative_date | correct | true | search search read_around | W październiku wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała 14 października, że wysłano kole |
| rel08 | relative_date | correct | - | summarize | Last week (Mon 2 to Sun 8 Nov) the space had 30 messages, mostly small status posts. The main threads were: -  |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell podała 23 października, że nowa strona przeszła audyt dostępności z wynikiem 96/100 w Lighthous |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 2 950 USD za kontener 20' z Shenzhen, z odjazdami co tydzień. Wiadomość jest z 15 październi |
| none01 | no_answer | correct | - | search search search search | Nie znalazłem NIP-u firmy Plastmet w Flux. Wyszukiwanie po „NIP” i „Plastmet” w wiadomościach i Wiki nie zwróc |
| none02 | no_answer | correct | - | search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. I searched for Wi-Fi, wifi, network and passwor |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux kwoty, jaką zapłaciliśmy za reklamy na LinkedIn w październiku. Wyszukiwanie po polsku i  |
| none04 | no_answer | correct | - | search search search search search search get_doc | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for "Tomasz Wójcik", "Wójcik" and "Tomasz"  |
| none05 | no_answer | correct | - | search search search search search search search list_contexts | Nie znalazłem w Flux żadnej informacji o umowie z Krakowem na stacje. Szukałem po „Kraków”, „Krakow” i „Krakow |
| none06 | no_answer | correct | - | search search search search search | I couldn't find any record of an ATEX certificate or the body that issued it in Flux. Searches for "ATEX", "no |
| none07 | no_answer | correct | - | search search search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Przeszukałem wiadomości, Wiki i materiały po nazwie  |
