# Answer accuracy (#1295): claude-haiku-5-5, variant main, pi-1441-2

Flux 925b5f69e (main; harness a9035549a) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.1795 agent + $0.0085 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.933 | 14 / 0 / 1 / 0 | 0 | 1 | 1 | 1 | 0.933 (0.933) | - | 9 | 931 | 0.00319 | 8.1 / 10.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 8 | 978 | 0.00518 | 8.1 / 8.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 (1) | - | 8 | 675 | 0.00235 | 6.2 / 8.2 |
| file | 6 | 1 | 6 / 0 / 0 / 0 | 0 | 0.833 | 1 | 1 | 0 (0.833) | - | 8 | 560 | 0.0019 | 6.1 / 6.2 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.714 (1) | - | 8 | 679 | 0.00206 | 6.1 / 10.1 |
| two_source | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 0.857 | 1 (1) | - | 9 | 1305 | 0.00359 | 10.1 / 13.1 |
| relative_date | 10 | 1 | 10 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.8 (0.8) | 0.6 | 8 | 965 | 0.00272 | 7.1 / 11.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 10 | 1035 | 0.00349 | 8.1 / 10.1 |
| **all** | 62 | 0.984 | 61 / 0 / 1 / 0 | 0 | 0.981 | 1 | 0.981 | 0.8 (0.927) | 0.6 | 8 | 895 | 0.0029 | 7.1 / 10.2 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski napisał o nim w Czujnikach 14 kwietnia 202 |
| old02 | old_messages | correct | true | search search search read_around | Piotr Zieliński's bench test reported about **14 months** on two 18650 cells with measurements every 10 minute |
| old03 | old_messages | correct | true | search search read_around | Kalibracja w komorze klimatycznej dała stały offset **+0,8°C** dla serii z lutego. Marta Wiśniewska zapisała t |
| old04 | old_messages | correct | true | search search read_around search | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Piotr Zieliński zmierz |
| old05 | old_messages | correct | true | search search search search search search read_around search | The fund is Black Pine. In your 2 October message in the Zarząd space, you wrote that it wants to invest 2.5 m |
| old06 | old_messages | correct | true | search search search search search read_around | Płytki montuje teraz **Eurocircuits**. Sarah Mitchell zapisała 27 maja 2026 decyzję o przeniesieniu montażu PC |
| old07 | old_messages | correct | true | search search search search search | Najnowsza liczba, jaką znalazłem, to **12 kompletnych stacji** w magazynie w Pruszczu. Podał ją Piotr Zielińsk |
| old08 | old_messages | correct | true | search search search search search read_around | We chose **Payload** over Strapi for the website relaunch. Jonas Berg said the main reasons were its TypeScrip |
| old09 | old_messages | correct | true | search search get_doc | W Flux znalazłam dwie kary dla Gdańska, i nie są to te same kary: - **0,2% za każdy dzień zwłoki** w montażu 6 |
| old10 | old_messages | correct | true | search search search read_around | Według Piotra Zielińskiego z lipca 2026, panel 6 W wystarcza do całorocznej pracy tylko na południowych dachac |
| old11 | old_messages | correct | true | search search search search read_around search search | Ada, the office is moving to Garbary 8, from 1 January (the message doesn't give the year, but it was written  |
| old12 | old_messages | correct | true | search search search search search read_around | The city reported that 4 stations in Przymorze show temperatures 5 degrees too high. The suspected cause is th |
| old13 | old_messages | wrong | true | search search search search search search read_around | Nie znalazłem w Flux informacji o dyżurze na przerwę wakacyjną ani świąteczną w obecnym okresie. Najbliższe wp |
| old14 | old_messages | correct | true | search search read_around get_doc | Według Flux wydania firmware zatwierdza od 15 października 2026 Marta Wiśniewska, a Jonas Berg prowadzi chmurę |
| old15 | old_messages | correct | true | search search | W Flux jest numer 58 323 11 47, ale podany jest dla **Haliny Kurek** (nie Kurrek), inż., kontakt po stronie mi |
| win01 | recent | correct | true | get_conversation search search | Dziś (piątek) stand-upu nie ma. Od tygodnia 9 listopada stand-up odbywa się o 9:30, we wtorki i czwartki, jak  |
| win02 | recent | correct | true | get_conversation search search read_around search | The stations reset because their firmware uses a `millis()` counter that overflows after about 49.7 days, so t |
| wiki01 | wiki | correct | true | search search get_doc | Klient ma **30 dni** od dostawy na zgłoszenie zwrotu stacji, a numer zgłoszenia ma format RMA-2026-NNN [1]. Zg |
| wiki02 | wiki | correct | true | list_contexts search search get_doc search | Our core hours are 10:00 to 14:00. Outside them, you can work when it suits you. This comes from the Wiki page |
| wiki03 | wiki | correct | true | search search search get_doc | Według listy kontrolnej wydania firmware (Czujniki, strona zaczęta dziś przez Marta Wiśniewską) każde wydanie  |
| wiki04 | wiki | correct | true | search search search get_doc | Transport jest gratis od 20 sztuk, according to the "Cennik i rabaty 2027" page in the Dostawy i logistyka spa |
| wiki05 | wiki | correct | true | search search get_doc | Roof installations are not allowed in wind above 12 m/s, according to the Wiki page "Montaż na dachu: BHP" (ve |
| wiki06 | wiki | correct | true | search search search search search get_doc | Do nagłówków na stronie używamy kroju **Fraunces**, a tekst podstawowy ma kroj **Inter**. Tak stoi w wiki „Bra |
| wiki07 | wiki | correct | true | search search get_doc | The response time for a failure reported by Gdańsk is **48 hours**, according to the Wiki page "Gdańsk: SLA i  |
| wiki08 | wiki | correct | true | search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu [1]. Ta sama strona "Urlopy" w Firma mówi też,  |
| file01 | file | correct | true | search search read_file | Według oferty Plastmetu nr 2026/311 obudowa ZD-ENC-3 (poliwęglan UV, kolor grafit) kosztuje 23,40 zł netto za  |
| file02 | file | correct | true | search search read_file | According to the post-mortem, the cloud outage was caused by the TLS certificate of the MQTT broker expiring.  |
| file03 | file | correct | true | search search read_file | Najwyższa temperatura w pliku **pomiary_ST-0417.csv** to **41,3 °C**, zanotowana 2026-10-06 o 13:00 [1]. Kolum |
| file04 | file | correct | false | search search read_file | The contractual penalty in the NDA with Sopot (Gmina Miasta Sopot) is 50,000 zł, payable by the party that bre |
| file05 | file | correct | true | search search read_file | Margines emisji promieniowanej w raporcie EMC (Gliwice, nr 2026-EMC-0912, stacja Zielony Dach rev. C) wynosi 4 |
| file06 | file | correct | true | search read_file | Station ST-0433 is installed at ul. Grunwaldzka 82, stop Jaśkowa Dolina, and it was installed on 2026-06-27. T |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion search | Według Flux zamówiliście **25 anten Taoglas FXP290** do wymiany na Przymorzu. Ola Lewandowska zamówiła je z do |
| tdm02 | task_decision_map | correct | true | search search get_task_discussion | Phoenix Testlab quoted 18,400 EUR for the RED tests, with six weeks from sample delivery. Jonas Berg posted th |
| tdm03 | task_decision_map | correct | true | search search get_task_discussion search | Według Flux stroną statusu będzie Better Stack, z adresem status.zielonydach.eu jako CNAME. Decyzję zapisała S |
| tdm04 | task_decision_map | correct | true | search search get_decision | The warranty for municipal customers is 36 months. That is the accepted decision "Gwarancja 36 miesięcy dla kl |
| tdm05 | task_decision_map | correct | true | search search get_decision | W rewizji D złączem serwisowym ma być USB-C, a jedynym portem serwisowym będzie właśnie on; micro-USB odpada.  |
| tdm06 | task_decision_map | correct | true | search search get_map | Według mapy „Pomysły na 2027” w przestrzeni Czujniki abonament na dane miałby kosztować **9 zł miesięcznie za  |
| tdm07 | task_decision_map | correct | true | list_contexts search get_map | On the "Website ideas" map in Website relaunch, the live map of stations is written to refresh every 10 minute |
| two01 | two_source | correct | true | search search get_doc read_around | Przy 60 sztukach samorząd zapłaci około **1 096,50 zł netto za stację**, czyli około 65 790 zł netto za całość |
| two02 | two_source | correct | true | search search get_doc search search search | Marta Wiśniewska approves firmware releases. Ada's message of 15 October 2026 says so: "od teraz wydania firmw |
| two03 | two_source | correct | true | search search search get_doc search | Według Wiki "Gdańsk: SLA i kontakty" czas reakcji na awarię zgłoszoną przez miasto to **48 godzin**, a za prze |
| two04 | two_source | correct | true | search search search search get_doc read_around search | The new embedded developer, Kamil Duda, was set to start on 1 September 2026, on a B2B contract. Marta Wiśniew |
| two05 | two_source | correct | true | search search search get_doc get_decision search | Gwarancja dla Gdańska, według Flux, to co najmniej 36 miesięcy, bo przetargi samorządowe tego wymagają, a reze |
| two06 | two_source | correct | true | search search search get_work get_task_discussion read_around | Miasto zgłosiło, że 4 stacje na Przymorzu pokazują temperaturę o 5 stopni za wysoką, a Ada podejrzewała nagrze |
| two07 | two_source | correct | true | search search read_file | One Plastmet enclosure (ZD-ENC-3) costs 23.40 zł net per piece, but only at a 1000-piece order; the offer is P |
| rel01 | relative_date | correct | true | search search read_around | Około półtora miesiąca temu, 30 września, Bogdan Kowalski napisał w wątku zarządu: „Ustaliliśmy budżet marketi |
| rel02 | relative_date | correct | true | search search read_around search | In early October, Maurycy Lis wrote in the Dostawy i logistyka space (5 Oct 2026) that he had spoken with Elfa |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu (2–8 listopada) w przestrzeni było 41 wiadomości. Najważniejsze: - **Wysyłki:** kilka wysył |
| rel04 | relative_date | correct | true | search search search search | The message is from Ola Lewandowska on 13 September 2026 in "Dostawy i logistyka": "Faktura FV/0915/2026 od Eu |
| rel05 | relative_date | correct | true | search search search read_around | W miniony weekend (7–8 listopada) dyżur miał Jonas Berg. Wynika to z wiadomości Piotra Zielińskiego z 6 listop |
| rel06 | relative_date | correct | true | search search search search | Piotr Zieliński said on 3 October 2026 that **firmware 2.6** passed testing on 20 stations, with zero restarts |
| rel07 | relative_date | correct | true | search search read_around read_file search | W październiku 2026 wysłaliście do Gdańska **18 stacji**. Ola Lewandowska napisała 14 października: "Wysłaliśm |
| rel08 | relative_date | correct | - | get_conversation summarize | Last week (Mon 2 to Sun 8 November) the space had 30 messages, mostly in the "Website relaunch" thread. Key po |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell napisała 23 października 2026 w Website relaunch, że nowa strona przeszła audyt dostępności z w |
| rel10 | relative_date | correct | true | search search search read_around | Maurycy Lis podał 15 października 2026 w Dostawach i logistyce, że fracht morski z Shenzhen wynosi 2 950 USD z |
| none01 | no_answer | correct | - | search search search read_file search search search | Nie znalazłam NIP-u firmy Plastmet w Flux. Przeszukałam wiadomości, pliki i Wiki pod kątem „NIP”, „identyfikat |
| none02 | no_answer | correct | - | search search search search search search search search | I couldn't find the Wi-Fi password in Flux. I searched for Wi-Fi, password, SSID, router and "new office" in E |
| none03 | no_answer | correct | - | search search search search search search search search | Nie znalazłem w Flux kwoty wydatków na reklamy na LinkedIn za październik. Wyszukiwałem po polsku i po angiels |
| none04 | no_answer | correct | - | search search search search search search | I couldn't find Tomasz Wójcik's phone number in Flux. Searches for his name in its variants (Wójcik, Wojcik, T |
| none05 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux żadnej informacji o umowie z Krakowem na stacje, ani podpisanej, ani w negocjacjach. Szuk |
| none06 | no_answer | correct | - | search search search search search search search | I couldn't find anything in Flux about an ATEX certificate or which certification body issued it. Searches in  |
| none07 | no_answer | correct | - | search search search search search search | Nie znalazłem w Flux numeru konta bankowego Eurocircuits. Szukałem po nazwie firmy, IBAN i „numer konta”, bez  |
