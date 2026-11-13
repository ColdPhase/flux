# Answer accuracy (#1295): claude-haiku-5-5, variant main, 1410-main-1

Flux a0237fbab (main; harness 334fef96b) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2443 agent + $0.0086 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.9 | 13 / 1 / 0 / 1 | 0 | 0.933 | 0.933 | 0.933 | 0 (0) | - | 32204 | 634 | 0.00354 | 6.1 / 10.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.5 (0.5) | - | 34830 | 534 | 0.00375 | 6.1 / 6.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (1) | - | 28287 | 515 | 0.00309 | 6.1 / 7.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0 | 0 (0.833) | - | 51342 | 850 | 0.00556 | 8.1 / 11.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.143 (0.857) | - | 25364 | 495 | 0.00278 | 6.1 / 11.2 |
| two_source | 7 | 0.643 | 2 / 5 / 0 / 0 | 0 | 0.571 | 1 | 0.571 | 0 (0.714) | - | 49073 | 1100 | 0.00546 | 9.1 / 12.2 |
| relative_date | 10 | 0.9 | 9 / 0 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0 (0) | 0.7 | 31010 | 743 | 0.00347 | 6.1 / 8.4 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 44071 | 705 | 0.00476 | 8.2 / 9.2 |
| **all** | 62 | 0.823 | 48 / 6 / 0 / 8 | 0 | 0.792 | 0.945 | 0.792 | 0.036 (0.455) | 0.7 | 35915 | 699 | 0.00394 | 6.1 / 11.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał o nim 14 kwietnia 2026 w przestrze |
| old02 | old_messages | dont_know | false | search search search search | I couldn't find a battery-life figure for a station measuring every ten minutes in Flux. Ada, you asked in the |
| old03 | old_messages | correct | true | search search | Według Flux po kalibracji w komorze klimatycznej wyszedł stały offset **+0,8°C** dla serii z lutego. Napisała  |
| old04 | old_messages | correct | true | search search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Piotr Zieliński zmierz |
| old05 | old_messages | correct | true | search search search | The only offer I found in Flux is from the Black Pine fund, in your message in the Zarząd space on 2 October 2 |
| old06 | old_messages | correct | true | search search search search search read_around list_decisions | Płytki montuje teraz **Eurocircuits**. Decyzję o przeniesieniu montażu PCB z Satel-Tech do Eurocircuits ogłosi |
| old07 | old_messages | correct | true | search search search search | Ostatnia znana liczba to **12 kompletnych stacji** w magazynie w Pruszczu. Podał ją Piotr Zieliński w wątku Do |
| old08 | old_messages | correct | true | search list_decisions search list_decisions search search read_around | The site uses **Payload** as its CMS. Jonas Berg said in the Website relaunch conversation on 14 May 2026 that |
| old09 | old_messages | correct | true | search search | Według wiadomości Ady z 16 czerwca, w umowie z Gdańskiem kara umowna wynosi **0,2% za każdy dzień zwłoki** (#2 |
| old10 | old_messages | correct | true | search search search read_around | Na północnych dachach trzeba dać panel 10 W. Piotr Zieliński napisał to 15 lipca 2026 w Czujnikach, w wątku o  |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, from 1 January. You wrote this in the Zarząd space on 12 September 2026, an |
| old12 | old_messages | partial | true | search search read_around | The city reported that 4 stations in Przymorze show temperatures about 5 °C too high. Ada's note from 27 Octob |
| old13 | old_messages | correct | true | search search search search search | Nie znalazłem w Flux informacji o dyżurze na obecną przerwę wakacyjną. Najbliższe wpisy dotyczą weekendów: w C |
| old14 | old_messages | correct | true | search search search | Według wiadomości Ady Nowak z 15 października 2026 w przestrzeni Czujniki, wydania firmware zatwierdza Marta W |
| old15 | old_messages | correct | true | search search | Według Flux Halina (inż.) Kurek, kontakt po stronie miasta, ma telefon **58 323 11 47**. Podał go Ada Nowak 18 |
| win01 | recent | correct | true | search search | Nie znalazłem w wątku godziny obecnego stand-upu. Ada Nowak napisała 9 listopada, że od przyszłego tygodnia st |
| win02 | recent | correct | true | search | Jonas Berg found the cause on 10 Nov: the units reboot every 49.7 days because the `millis()` counter overflow |
| wiki01 | wiki | correct | true | search search | Według wiki **Procedura zwrotów (RMA)** w przestrzeni Czujniki klient ma **30 dni od dostawy** na zgłoszenie z |
| wiki02 | wiki | correct | true | search search get_doc | Our core working hours are 10:00 to 14:00, according to the "Onboarding: the first week" wiki page in the Firm |
| wiki03 | wiki | correct | true | search search get_doc | Test wygrzewania trwa według Flux **72 godziny** na 20 stacjach na stanowisku testowym, zanim ruszy pierwsza f |
| wiki04 | wiki | correct | true | search search search get_doc | Według wiki „Cennik i rabaty 2027” (Dostawy i logistyka, autor Bogdan Kowalski) transport jest gratis od 20 sz |
| wiki05 | wiki | correct | true | search search | Roof installations are not allowed above a wind speed of **12 m/s**. This comes from the wiki page "Montaż na  |
| wiki06 | wiki | correct | true | search search search search get_doc | Nagłówki na stronie używają czcionki **Fraunces**, a tekst główny używa **Inter**. Wynika to z wiki "Brand gui |
| wiki07 | wiki | correct | true | search search | Flux says the city of Gdańsk gets a **48-hour response time** for a failure it reports. The source is the wiki |
| wiki08 | wiki | correct | true | search search | Według wiki **Urlopy** w przestrzeni Firma urlop zgłasza się **co najmniej 14 dni wcześniej** w Kadromierzu. T |
| file01 | file | dont_know | false | search search read_around search search | W Flux nie znalazłem ceny obudowy w ofercie Plastmetu. Oferta jest załącznikiem do wiadomości Bogdana Kowalski |
| file02 | file | dont_know | false | search search read_around search search search search search | I can't tell you what caused the outage. The post-mortem is attached to a message from Piotr Zieliński in the  |
| file03 | file | dont_know | false | search list_contexts read_around search list_materials | Nie mogę odczytać tej wartości. Plik **pomiary_ST-0417.csv** (30 wierszy) został wysłany przez Tomasza Wójcika |
| file04 | file | dont_know | false | search search read_around search list_materials | I couldn't find the penalty in Flux. The NDA with Sopot was signed on 22 September 2026, and Ada Nowak posted  |
| file05 | file | dont_know | false | search search read_around search search search | Nie znalazłem w Flux liczby marginesu emisji promieniowanej. Raport z Gliwic (EMC_report_Gliwice.pdf, nr EMC/2 |
| file06 | file | dont_know | false | search search search search | I couldn't find any record of station ST-0433 in Flux, so I can't say where it is installed. The only station  |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion search | Według Flux zamówiliście **25 anten Taoglas FXP290**. Zamówienie zapisała Ola Lewandowska w dyskusji zadania # |
| tdm02 | task_decision_map | correct | true | search search | Phoenix Testlab quoted **18,400 EUR** for the RED tests, with six weeks from sample delivery. Jonas Berg poste |
| tdm03 | task_decision_map | correct | true | search search search search | Według Flux strona statusu ma działać na **Better Stack**, pod adresem **status.zielonydach.eu** jako CNAME. Z |
| tdm04 | task_decision_map | correct | true | search search | The accepted decision "Gwarancja 36 miesięcy dla klientów samorządowych" (in the space Klient: Miasto Gdańsk,  |
| tdm05 | task_decision_map | correct | true | search search | W rewizji D jedynym portem serwisowym ma być **USB-C**. Wynika to z zaakceptowanej decyzji „USB-C as the only  |
| tdm06 | task_decision_map | correct | true | search search get_map | Według Twojej mapy „Pomysły na 2027” (przestrzeń Czujniki) abonament na dane ma kosztować **9 zł miesięcznie z |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | The "Website ideas" map in the Website relaunch space has a card from Sarah Mitchell that reads "Live map of e |
| two01 | two_source | correct | true | search search get_doc search read_around | Według Flux wychodzi około **1 096,50 zł netto za stację**, czyli około **65 790 zł netto** za 60 sztuk. To wy |
| two02 | two_source | partial | true | search search get_doc search search list_decisions | Flux does not name who approves firmware releases now. The only relevant text is the "Firmware release checkli |
| two03 | two_source | correct | true | search search get_doc search | Zgłoszoną przez miasto awarię musicie podjąć w ciągu **48 godzin**. Wymiana stacji zajmuje 5 dni roboczych, a  |
| two04 | two_source | partial | false | search search search search | I couldn't find a start date for the new embedded developer in Flux. The searches only turned up recruiting me |
| two05 | two_source | partial | true | search search search get_doc get_decision | **Gwarancja:** Zaakceptowana decyzja „Gwarancja 36 miesięcy dla klientów samorządowych” mówi, że przetargi wym |
| two06 | two_source | partial | false | search search get_work read_around read_around search | Miasto Gdańsk zgłosiło, że **4 stacje na Przymorzu** pokazują temperaturę o 5 stopni za wysoką. Podejrzewacie  |
| two07 | two_source | partial | false | search search search read_around | I couldn't find the unit price of a Plastmet enclosure in Flux. Bogdan Kowalski posted a Plastmet offer for en |
| rel01 | relative_date | correct | true | search search search read_around | Około półtora miesiąca temu, 30 września, Bogdan Kowalski napisał w rozmowie Zarząd: „Ustaliliśmy budżet marke |
| rel02 | relative_date | dont_know | false | search search search search search | I couldn't find anything from Maurycy about the supplier in early October. Searches for his name across all th |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu, od poniedziałku 2 do niedzieli 8 listopada, w przestrzeni "Dostawy i logistyka" napisano 4 |
| rel04 | relative_date | correct | true | search search | The message is from Ola Lewandowska on 13 September 2026 in the "Dostawy i logistyka" space. It gives invoice  |
| rel05 | relative_date | correct | true | search search search read_around | W miniony weekend (7–8 listopada) dyżur w przestrzeni Czujniki miał Jonas. Wskazała to wiadomość Piotra Zieliń |
| rel06 | relative_date | correct | true | search search | According to Piotr Zieliński's message on 3 October 2026 in the Czujniki space, **firmware 2.6** passed testin |
| rel07 | relative_date | correct | true | search search search read_around | W zeszłym miesiącu, czyli w październiku, wysłano do Gdańska **18 stacji**. Wynika to z wiadomości Oli Lewando |
| rel08 | relative_date | correct | - | summarize | Last week (Mon 2 to Sun 8 November) the thread had 30 messages. The main points: - **Site performance:** Light |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell wrote on 23 October 2026 in Website relaunch that the new site passed the accessibility audit w |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał w połowie października (15 października) fracht morski z Shenzhen na poziomie **2 950 USD za |
| none01 | no_answer | correct | - | search search search | Nie znalazłem NIP-u firmy Plastmet w Flux. Wyszukiwanie po „NIP Plastmet”, „Plastmet” i „NIP” nie zwróciło żad |
| none02 | no_answer | correct | - | search search search search search search search | I couldn't find the Wi-Fi password in Flux. I searched for Wi-Fi, password, network and router terms in Englis |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux kwoty, jaką zapłaciliście za reklamy na LinkedInie w październiku. Wyszukiwałem po polsku |
| none04 | no_answer | correct | - | search search search search get_doc | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for his name returned no matches, and the o |
| none05 | no_answer | correct | - | search search search search search search | Nie znalazłem w Flux żadnej umowy z Krakowem: wyszukiwanie „Kraków”, „Krakowem” i „Krakow” nic nie zwróciło. Z |
| none06 | no_answer | correct | - | search search search search | I couldn't find any mention of an ATEX certificate or its certification body in Flux. The search for "ATEX", " |
| none07 | no_answer | correct | - | search search search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Wyszukiwania po „Eurocircuits”, „IBAN”, „konto banko |
