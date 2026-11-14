# Answer accuracy (#1295): claude-haiku-5-5, variant main, v021-gate-95a6a6d1c

Flux 95a6a6d1c (main; harness 95a6a6d1c) · 2026-11-14 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.18 agent + $0.0087 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.9 | 13 / 1 / 1 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 9 | 901 | 0.00303 | 8.1 / 10.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 7 | 925 | 0.00433 | 7.1 / 7.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 8 | 700 | 0.00237 | 7.1 / 9.1 |
| file | 6 | 1 | 6 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (0.833) | - | 8 | 526 | 0.00188 | 6.1 / 6.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (1) | - | 8 | 655 | 0.00199 | 6.1 / 10.1 |
| two_source | 7 | 0.857 | 5 / 2 / 0 / 0 | 0 | 0.714 | 1 | 0.714 | 1 (1) | - | 9 | 1308 | 0.00366 | 9.1 / 11.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0.7 (0.7) | 0.6 | 9 | 1207 | 0.00314 | 7.1 / 18.2 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 10 | 1076 | 0.00352 | 8.1 / 10.1 |
| **all** | 62 | 0.944 | 57 / 3 / 1 / 1 | 0 | 0.943 | 0.982 | 0.943 | 0.8 (0.927) | 0.6 | 9 | 927 | 0.0029 | 7.1 / 11.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał o nim w Czujniki 14 kwietnia 2026: |
| old02 | old_messages | correct | true | search search read_around | The only figure in Flux is from Piotr Zieliński's battery test: at a 10-minute measuring interval, a station l |
| old03 | old_messages | correct | true | search search search | W Flux jest jeden konkretny wynik: po kalibracji w komorze klimatycznej wyszedł stały offset **+0,8°C** dla se |
| old04 | old_messages | correct | true | search search search read_around | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg ok. 2,7 km. Piotr Zieliński zmierzył |
| old05 | old_messages | correct | true | search search search search search read_around search search | The fund is Black Pine. In Ada's message in the Zarząd space on 2 October 2026, it wanted to invest 2.5 mln zł |
| old06 | old_messages | correct | true | search search search read_around search | Płytki montuje teraz **Eurocircuits**. Decyzja z 27 maja 2026 mówi, że montaż PCB przechodzi z Satel-Tech na E |
| old07 | old_messages | correct | true | search search search search search | Ostatni zapisany stan to **12 kompletnych stacji** w magazynie w Pruszczu, z 30 września, od Piotra Zielińskie |
| old08 | old_messages | correct | true | search search search search search read_around | We chose **Payload** over Strapi. Jonas Berg wrote in the Website relaunch chat on 14 May 2026 that the main r |
| old09 | old_messages | partial | true | search search | Umowa z Gdańskiem ma dwie kary umowne, i Flux podaje je w różnych dokumentach: - **0,2% za każdy dzień zwłoki* |
| old10 | old_messages | correct | true | search search search search search read_around | Według Flux na północnych dachach potrzebny jest panel o mocy **10 W**, a 6 W wystarcza tylko na południowych  |
| old11 | old_messages | correct | true | search search search search search read_around search | The office is moving to Garbary 8, from 1 January, most likely 2027, since your note is dated 12 September 202 |
| old12 | old_messages | correct | true | search search search search read_around search | The city reported that 4 stations in Przymorze show temperatures 5 degrees too high. Ada's own note from 27 Oc |
| old13 | old_messages | wrong | true | search search search search read_around | Flux doesn't say who is on phone duty during a holiday break in November. I found no message about that break, |
| old14 | old_messages | correct | true | search search get_doc read_around | Wydania firmware zatwierdza od 15 października 2026 Marta Wiśniewska; Jonas Berg przejął sprawy chmury. Tak za |
| old15 | old_messages | correct | true | search search | W Flux jest numer dla **inż. Haliny Kurek** (pisownia z jednym „r”, nie „Kurrek”): 58 323 11 47. Podano go jak |
| win01 | recent | correct | true | get_conversation search search | Dziś, w sobotę, stand-upu nie ma. Według Twojej wiadomości z 9 listopada od przyszłego tygodnia stand-up przen |
| win02 | recent | correct | true | get_conversation search read_around | The restarts come from a timer overflow in the station firmware. Jonas Berg found that units reboot every 49.7 |
| wiki01 | wiki | correct | true | search search get_doc | Klient ma 30 dni od dostawy na zgłoszenie zwrotu stacji. Zgłoszenia przyjmuje serwis@zielonydach.eu, a odpowia |
| wiki02 | wiki | correct | true | search search get_doc | Our core working hours are 10:00 to 14:00, and outside them you can work when it suits you. This is in the Fir |
| wiki03 | wiki | correct | true | search search search get_doc search | Test wygrzewania (soak test) trwa **72 godziny** na 20 stacjach w racku testowym, zanim ruszy pierwsza fala ak |
| wiki04 | wiki | correct | true | search search search get_doc | Transport is free from 20 pieces, according to the "Cennik i rabaty 2027" price list in the Dostawy i logistyk |
| wiki05 | wiki | correct | true | search search get_doc search | Roof installations are not allowed when the wind is above **12 m/s**, according to the "Montaż na dachu: BHP"  |
| wiki06 | wiki | correct | true | search search search search search | Nagłówki na stronie używają kroju **Fraunces**, a tekst główny kroju **Inter**, według wytycznych marki w Wiki |
| wiki07 | wiki | correct | true | search search search get_doc | Gdańsk's reaction time for a failure they report is **48 hours**, and each day over the SLA costs **200 zł** [ |
| wiki08 | wiki | correct | true | search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu, według strony Wiki „Urlopy” w przestrzeni Firm |
| file01 | file | correct | true | search search read_file | Według oferty Plastmetu nr 2026/311 obudowa ZD-ENC-3 (poliwęglan UV, kolor grafit) kosztuje 23,40 zł netto za  |
| file02 | file | correct | true | search search read_file | According to the post-mortem, the cause was an expired TLS certificate on the MQTT broker. Renewal was a manua |
| file03 | file | correct | true | search search read_file | Najwyższa zanotowana temperatura w pliku `pomiary_ST-0417.csv` to **41,3 °C**, z 19 października 2026 o godzin |
| file04 | file | correct | true | search search read_file | The contractual penalty in the NDA with Sopot is 50 000 zł. Under § 5, a party that breaches confidentiality p |
| file05 | file | correct | true | search search read_file | Margines emisji promieniowanej w raporcie EMC (raport 2026-EMC-0912, stacja Zielony Dach rev. C) wyniósł 4,2 d |
| file06 | file | correct | true | search read_file | Station ST-0433 is at ul. Grunwaldzka 82, stop Hucisko, and was installed on 2026-08-17. This comes from the s |
| tdm01 | task_decision_map | correct | true | search search get_task_discussion get_work search | Zamówiono **25 anten Taoglas FXP290**. Zamówiła je Ola Lewandowska 2 listopada, z dostawą na 2 grudnia, a mont |
| tdm02 | task_decision_map | correct | true | search search search | Phoenix Testlab quoted 18,400 EUR for the RED tests, with six weeks from sample delivery, according to Jonas B |
| tdm03 | task_decision_map | correct | true | search search search get_task_discussion | Według Flux do strony statusu wybraliście Better Stack, z adresem status.zielonydach.eu jako CNAME. Sarah Mitc |
| tdm04 | task_decision_map | correct | true | search search get_decision | The warranty for municipal customers is 36 months. That is the accepted decision "Gwarancja 36 miesięcy dla kl |
| tdm05 | task_decision_map | correct | true | search search get_decision | W rewizji D złączem serwisowym będzie USB-C, które jest jedynym portem serwisowym od tej rewizji. Decyzję zaak |
| tdm06 | task_decision_map | correct | true | search search get_map | Na mapie „Pomysły na 2027” w przestrzeni Czujniki jest jeden wpis Ady Nowak: „Abonament na dane: 9 zł miesięcz |
| tdm07 | task_decision_map | correct | true | list_contexts search get_map | The "Website ideas" map in the Website relaunch space says the live map of every public station is **refreshed |
| two01 | two_source | correct | true | search search get_doc read_around | Według Flux samorząd zapłaci około **1 096,50 zł netto za stację** przy zamówieniu 60 sztuk w 2027 roku, czyli |
| two02 | two_source | correct | true | search search get_doc search search search | Marta Wiśniewska approves firmware releases now. Ada's message in the Czujniki space says: "od teraz wydania f |
| two03 | two_source | partial | false | search search search get_doc search read_around | Z Flux nie wynika, kogo w Gdańsku powiadomić. Strona "Gdańsk: SLA i kontakty" podaje tylko warunki: reakcja na |
| two04 | two_source | partial | false | search search get_doc search search search search | I couldn't find a start date for the new embedded developer in Flux. The Rekrutacja space shows the embedded d |
| two05 | two_source | correct | true | search search search get_doc get_decision search | Gwarancja dla Gdańska to **36 miesięcy**, bo przetargi samorządowe tego wymagają, a rezerwa na naprawy wynosi  |
| two06 | two_source | correct | true | search search search get_task_discussion read_around | Miasto Gdańsk complained that **4 stations on Przymorze** show a temperature 5 degrees too high, and the team  |
| two07 | two_source | correct | true | search search read_file read_around | One Plastmet enclosure (model ZD-ENC-3, UV polycarbonate, graphite) is quoted at 23.40 zł net each, but only f |
| rel01 | relative_date | correct | true | search search read_around | Około 1 października 2026 Bogdan Kowalski w rozmowie Zarządu napisał: „Ustaliliśmy budżet marketingowy na pier |
| rel02 | relative_date | dont_know | false | search search search search search search | I couldn't find anything from Maurycy about a supplier in early October. Flux has no message, task or Wiki pag |
| rel03 | relative_date | correct | - | summarize get_conversation summarize | W zeszłym tygodniu (2–8 listopada) w przestrzeni były 41 wiadomości, głównie w wątku „FYI Jutro pracuję zdalni |
| rel04 | relative_date | correct | true | search search search | The message is from Ola Lewandowska in "Dostawy i logistyka" on 2026-09-14 (10:25 UTC): "Faktura FV/0915/2026  |
| rel05 | relative_date | correct | true | search search search read_around | Według Flux dyżur w minionym weekendzie (7–8 listopada) miał Jonas Berg. Piotr Zieliński napisał to w Czujnika |
| rel06 | relative_date | correct | true | search search search search read_around | Firmware **2.6** passed testing, according to Piotr Zieliński's message of 3 October 2026. He wrote that it pa |
| rel07 | relative_date | correct | true | search search search read_around search search read_around read_file | W październiku wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała 14 października: "Wysłaliśmy do  |
| rel08 | relative_date | correct | - | summarize | Last week (Mon 2 to Sun 8 November) the Website relaunch space had 30 messages, mostly about performance, cont |
| rel09 | relative_date | correct | true | search search read_around | Sarah Mitchell napisała 24 października w "Website relaunch", że nowa strona przeszła audyt dostępności z wyni |
| rel10 | relative_date | correct | true | search search read_around | Maurycy Lis podał 15 października 2026 frachtu morskiego z Shenzhen w wysokości 2 950 USD za kontener 20', z o |
| none01 | no_answer | correct | - | search search read_file search search search | Nie znalazłem NIP-u firmy Plastmet w Flux. Przeszukałem wiadomości, pliki i Wiki, a w ofercie Plastmetu (Ofert |
| none02 | no_answer | correct | - | search search search search search search search list_contexts search search search | I couldn't find the Wi-Fi password for the new office in Flux. I searched in English and Polish for Wi-Fi, pas |
| none03 | no_answer | correct | - | search search search search search search search search | Nie znalazłam w Flux kwoty wydatków na reklamy LinkedIn za październik. Wyszukiwania po LinkedIn, reklamach, f |
| none04 | no_answer | correct | - | search search search search search search search get_doc search search | I couldn't find a phone number for Tomasz Wójcik in Flux. Searches for "Tomasz Wójcik", "Wójcik", "Wojcik" and |
| none05 | no_answer | correct | - | search search search search search search | Nie znalazłam w Flux żadnej wzmianki o umowie z Krakowem. Szukałam „Kraków”, „Krakowa”, „Krakow” i „Cracow” we |
| none06 | no_answer | correct | - | search search search search search | I couldn't find any record of an ATEX certificate or its certification body in Flux. Searches in English and P |
| none07 | no_answer | correct | - | search search search search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Przeszukałem wiadomości, pliki i Wiki, a w rozmowach |
