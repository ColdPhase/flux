# Answer accuracy (#1295): claude-haiku-5-5, variant main, 1381-A-2

Flux 58c10e9e4 (main; harness 7b31d081a) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2544 agent + $0.0087 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.933 | 14 / 0 / 1 / 0 | 0 | 0.933 | 1 | 1 | 0.933 (0.933) | - | 34634 | 630 | 0.00378 | 6.1 / 12.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 1 (1) | - | 39980 | 617 | 0.00431 | 7.1 / 7.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 24895 | 519 | 0.00275 | 4.1 / 7.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.667 | 0 | 0 (0.667) | - | 60127 | 863 | 0.00644 | 9.1 / 11.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (1) | - | 26942 | 560 | 0.00297 | 5.1 / 7.1 |
| two_source | 7 | 0.786 | 4 / 3 / 0 / 0 | 0 | 0.571 | 1 | 0.429 | 1 (1) | - | 46010 | 1029 | 0.00512 | 8.1 / 10.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0.7 (0.7) | 0.7 | 33812 | 824 | 0.00379 | 7.1 / 10.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 44819 | 710 | 0.00484 | 7.1 / 8.1 |
| **all** | 62 | 0.847 | 51 / 3 / 1 / 7 | 0 | 0.792 | 0.927 | 0.774 | 0.782 (0.891) | 0.7 | 37450 | 715 | 0.0041 | 7.1 / 10.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał 14 kwietnia 2026 w Czujnikach, że  |
| old02 | old_messages | correct | true | search search | According to a battery test Piotr Zieliński posted in Czujniki, a station measuring every 10 minutes lasted ** |
| old03 | old_messages | correct | true | search search | Jedyny konkretny wynik to offset **+0,8°C** dla serii z lutego, który po kalibracji w komorze klimatycznej zan |
| old04 | old_messages | correct | true | search search | Według wiadomości Piotra Zielińskiego z 5 maja 2026 bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zas |
| old05 | old_messages | correct | true | search search search search search search read_around | The Black Pine fund offered 2.5 million zł for a 15% stake. Ada Nowak wrote this in the Zarząd space on 2 Octo |
| old06 | old_messages | correct | true | search search search | Płytki montuje teraz **Eurocircuits**. Sarah Mitchell zapisała w wątku z 27 maja 2026, że montaż PCB przechodz |
| old07 | old_messages | correct | true | search search search search | Ostatni zapisany stan to **12 kompletnych stacji** w magazynie w Pruszczu, z 30 września, od Piotra Zielińskie |
| old08 | old_messages | correct | true | search list_contexts search list_decisions search search list_docs search | The site is built on **Payload** (a CMS), chosen over Strapi. Jonas Berg's message in the Website relaunch spa |
| old09 | old_messages | correct | true | search search | W Flux kara umowna w umowie z Gdańskiem to **0,2% za każdy dzień zwłoki** w montażu stacji, według wiadomości  |
| old10 | old_messages | correct | true | search search search search | Na północnych dachach Piotr Zieliński zalecił panel **10 W**. Napisał, że panel 6 W wystarcza do całorocznej p |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, from 1 January. This comes from your own message in the Zarząd space on 12  |
| old12 | old_messages | correct | true | search search search search search read_around | The city reported that **4 stations in Przymorze** show a temperature **5 degrees too high**. The suspected ca |
| old13 | old_messages | wrong | false | search search search read_around | Nie znalazłem w Flux planu dyżuru na obecną przerwę wakacyjną. Ostatni wpis o dyżurze telefonem serwisowym w p |
| old14 | old_messages | correct | true | search search search search | Według Flux firmware zatwierdza teraz Marta Wiśniewska. Ada Nowak zapisała tę zmianę 15 października 2026 w sp |
| old15 | old_messages | correct | true | search search | Flux has one number for her: inż. Halina Kurek (the surname is spelled "Kurek", not "Kurrek"), tel. 58 323 11  |
| win01 | recent | correct | true | search search search read_around | Dzisiaj (piątek) stand-up nie jest w tym wątku planowany. Ada napisała 9 listopada, że od przyszłego tygodnia  |
| win02 | recent | correct | true | - | The stations reboot about every 49.7 days because the `millis()` counter overflows, according to Jonas Berg [1 |
| wiki01 | wiki | correct | true | search search | Klient ma **30 dni od dostawy** na zgłoszenie zwrotu stacji, według procedury zwrotów (RMA) w przestrzeni Czuj |
| wiki02 | wiki | correct | true | search search | Your core working hours are **10:00 to 14:00**. Outside them, you work when it suits you. This comes from the  |
| wiki03 | wiki | correct | true | search search | Według listy kontrolnej wydań w Wiki test wygrzewania (soak test) trwa **72 godziny** i działa na 20 stacjach  |
| wiki04 | wiki | correct | true | search search | Transport jest gratis od **20 sztuk** według dokumentu "Cennik i rabaty 2027" z przestrzeni Dostawy i logistyk |
| wiki05 | wiki | correct | true | search search | Roof installations are not allowed in wind above **12 m/s**, according to the Wiki page "Montaż na dachu: BHP" |
| wiki06 | wiki | correct | true | search search search search get_doc | Nagłówki używają czcionki **Fraunces**, a tekst główny **Inter**. Tak stoi na stronie „Brand guidelines” w prz |
| wiki07 | wiki | correct | true | search search get_doc | According to the Wiki page "Gdańsk: SLA i kontakty", the response time for a failure reported by the city of G |
| wiki08 | wiki | correct | true | search search | Według Wiki w przestrzeni Firma urlop zgłasza się **co najmniej 14 dni wcześniej** w Kadromierzu [1]. Opieram  |
| file01 | file | dont_know | false | search search read_around search | Flux does not give me the enclosure price from Plastmet. The offer is a PDF, "Oferta_Plastmet_obudowy.pdf", po |
| file02 | file | dont_know | false | search search search search read_around search list_materials | I couldn't find the cause in Flux. The post-mortem is a file attached to Piotr Zieliński's message in the Czuj |
| file03 | file | dont_know | false | search search read_around read_material search search | Nie mogę odczytać tej wartości z Flux. Plik z pomiarami to `pomiary_ST-0417.csv` (30 wierszy), który Tomasz Wó |
| file04 | file | dont_know | false | search search search search | I couldn't find the contractual penalty for the Sopot NDA in Flux. The only record I found is Ada's message in |
| file05 | file | dont_know | false | search search read_around search search search read_around | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Raport z badań EMC z Gliwic, plik EMC_report_Gl |
| file06 | file | dont_know | false | search list_contexts search search search | I couldn't find station ST-0433 in Flux. Searches for "ST-0433" and "0433" returned no matches in the spaces y |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion search | Zamówiliście 25 anten Taoglas FXP290 do wymiany na Przymorzu, z dostawą 2 grudnia. Zamówienie zapisała Ola Lew |
| tdm02 | task_decision_map | correct | true | search search | The lab quote for the RED tests was **18,400 EUR** from Phoenix Testlab, with six weeks from sample delivery.  |
| tdm03 | task_decision_map | correct | true | search search | Według wiadomości Sarah Mitchell z 29 października w rozmowie projektu Website relaunch, stronę statusu prowad |
| tdm04 | task_decision_map | correct | true | search search | The warranty for municipal customers is **36 months**. The accepted decision "Gwarancja 36 miesięcy dla klient |
| tdm05 | task_decision_map | correct | true | search search get_decision | W rewizji D złączem serwisowym będzie USB-C, a jedynym portem serwisowym ma być właśnie on. Decyzja jest zaakc |
| tdm06 | task_decision_map | correct | true | search search get_map | Na mapie „Pomysły na 2027” w przestrzeni Czujniki jest pomysł dodany przez Ana Ada dzisiaj: abonament na dane  |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | On the "Website ideas" map in the Website relaunch space, the live map of every public station is set to refre |
| two01 | two_source | correct | true | search search get_doc read_around | Według Flux samorząd zapłaci około **1 096,50 zł netto za jedną stację**, czyli około **65 790 zł netto** za 6 |
| two02 | two_source | correct | true | search search get_doc search search search | Marta Wiśniewska approves firmware releases now. Ada Nowak announced that change in the Czujniki conversation  |
| two03 | two_source | partial | false | search search get_doc search | Na awarię zgłoszoną przez miasto musimy zareagować w ciągu **48 godzin**; za każdy dzień przekroczenia SLA gro |
| two04 | two_source | partial | false | search search search search search | Flux doesn't say when the new embedded developer started. I found no message, task or decision that gives a st |
| two05 | two_source | correct | true | search search search get_doc get_decision | Gwarancja dla Gdańska, zapisana w Flux: decyzja o gwarancji 36 miesięcy dla klientów samorządowych, bo przetar |
| two06 | two_source | correct | true | search search get_work get_task_discussion | Miasto zgłosiło, że 4 stacje na Przymorzu pokazują temperaturę o 5 stopni za wysoką. Podejrzewacie nagrzewanie |
| two07 | two_source | partial | false | search search search search | I could not find a unit price for a Plastmet enclosure in Flux. The closest lead is a Plastmet offer for enclo |
| rel01 | relative_date | correct | true | search search search read_around | Około półtora miesiąca temu, 30 września 2026, Bogdan Kowalski napisał w rozmowie Zarządu, że ustaliliście bud |
| rel02 | relative_date | dont_know | false | search search search search | I couldn't find anything Maurycy said about the supplier in early October. Searches for his name, and for "sup |
| rel03 | relative_date | correct | - | summarize | W tygodniu 2–8 listopada w przestrzeni były 41 wiadomości, głównie o wysyłkach, cłach, cenach i stanach magazy |
| rel04 | relative_date | correct | true | search search search search | The message is from Ola Lewandowska on 13 September 2026 in the Dostawy i logistyka space. It reads: "**Faktur |
| rel05 | relative_date | correct | true | search search search | Według Flux w weekend 7–8 listopada dyżur miał Jonas. Piotr Zieliński napisał w piątek 6 listopada w spacji Cz |
| rel06 | relative_date | correct | true | search search search read_around | Piotr's message from 3 October 2026 says firmware **2.6** passed testing on 20 stations, with zero restarts ov |
| rel07 | relative_date | correct | true | search search search read_around | W październiku 2026 wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała o tym 14 października, a łą |
| rel08 | relative_date | correct | - | summarize list_work | Last week (Mon 2 to Sun 8 November) had 30 messages in the thread, mostly short status updates. The main items |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell's message of 23 October 2026 in Website relaunch said the new site passed the accessibility aud |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 15 października 2026 frachtu morskiego z Shenzhen 2 950 USD za kontener 20', z odjazdami co  |
| none01 | no_answer | correct | - | search search search search | Nie znalazłem w Flux NIP-u firmy Plastmet. Wyszukiwanie po "Plastmet" zwróciło tylko wiadomości o zamówieniach |
| none02 | no_answer | correct | - | search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. Searches for "Wi-Fi", "wifi", "password", "hasł |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux żadnej informacji o wydatkach na reklamy na LinkedIn w październiku. Wyszukiwania po pols |
| none04 | no_answer | correct | - | search search search search search search | I couldn't find Tomasz Wójcik's phone number in Flux. Searches for his name, "Wójcik", "Tomasz" and "Tomasz nu |
| none05 | no_answer | correct | - | search search search search list_contexts | Nie znalazłem w Flux żadnej informacji o umowie z Krakowem na stacje. Wyszukiwanie hasła „Kraków” nie zwróciło |
| none06 | no_answer | correct | - | search search search search search get_work | I couldn't find which certification body issued the ATEX certificate in Flux. I searched in English and Polish |
| none07 | no_answer | correct | - | search search search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Przeszukałem wiadomości po polsku i angielsku, ale ż |
