# Answer accuracy (#1295): claude-haiku-5-5, variant main, 1381-main-1

Flux 58c10e9e4 (main; harness 1b4f46459) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.2529 agent + $0.0086 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.933 | 13 / 2 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (0) | - | 33218 | 684 | 0.00366 | 5.2 / 11.2 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 0.5 | 0.5 | 0.5 (0.5) | - | 37714 | 515 | 0.00403 | 6.1 / 6.1 |
| wiki | 8 | 1 | 8 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (1) | - | 30276 | 611 | 0.00333 | 6.1 / 7.1 |
| file | 6 | 0 | 0 / 0 / 0 / 6 | 0 | 0 | 0.833 | 0 | 0 (0.833) | - | 49810 | 851 | 0.00541 | 8.1 / 14.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.286 (0.857) | - | 23851 | 497 | 0.00263 | 5.1 / 6.2 |
| two_source | 7 | 0.571 | 2 / 4 / 1 / 0 | 1 | 0.429 | 1 | 0.429 | 0 (0.857) | - | 52142 | 1048 | 0.00574 | 8.2 / 9.1 |
| relative_date | 10 | 0.9 | 9 / 0 / 1 / 0 | 0 | 0.875 | 0.9 | 0.875 | 0 (0) | 0.6 | 32833 | 740 | 0.00365 | 6.2 / 9.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 47317 | 712 | 0.00509 | 8.2 / 18.2 |
| **all** | 62 | 0.823 | 48 / 6 / 2 / 6 | 1 | 0.792 | 0.945 | 0.774 | 0.055 (0.473) | 0.6 | 37198 | 717 | 0.00408 | 6.2 / 10.2 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search | Numer zamówienia TME na 400 sztuk SHT45 to **TME-2026-04471**. Bogdan Kowalski napisał o nim w wątku Czujniki  |
| old02 | old_messages | correct | true | search search read_around | The only figure in Flux is from Piotr Zieliński's battery test (May 22, 2026, in the Czujniki space's conversa |
| old03 | old_messages | correct | true | search search | Według Flux w komorze klimatycznej wyszedł stały offset **+0,8 °C** dla serii z lutego. Podała go Marta Wiśnie |
| old04 | old_messages | correct | true | search search | Według wiadomości Piotra Zielińskiego z 5 maja 2026 w Czujnikach, bramka LoRaWAN na dachu biurowca przy Grunwa |
| old05 | old_messages | correct | true | search search search | The investment fund is Black Pine. In your 2 October 2026 message in the Zarząd space, you wrote that it wants |
| old06 | old_messages | correct | true | search search search search read_around search search | Według decyzji Sarah Mitchell z 27 maja 2026 montaż płytek przechodzi z Satel-Tech do Eurocircuits, od czerwco |
| old07 | old_messages | correct | true | search search search search read_around | Ostatni podany stan to **12 kompletnych stacji** w magazynie w Pruszczu. Podał go Piotr Zieliński w wątku „Dos |
| old08 | old_messages | correct | true | search search list_decisions search list_decisions read_around | The site's CMS is **Payload**, chosen over Strapi. Jonas Berg gave the reason in the Website relaunch space on |
| old09 | old_messages | partial | true | search search | W Flux znalazłam dwie różne kary dla Gdańska, i nie wiem, która obowiązuje w każdym przypadku: - Wiadomość Ady |
| old10 | old_messages | correct | true | search search read_around | Według Piotra Zielińskiego z 15 lipca 2026 (wątek Czujniki) na północnych dachach trzeba dać panel 10 W. Panel |
| old11 | old_messages | correct | true | search search search | The office is moving to Garbary 8, starting 1 January. You wrote this in the Zarząd space on 12 September 2026 |
| old12 | old_messages | correct | true | search search read_around read_around | The city reported that **4 stations in Przymorze** show temperatures about **5 degrees too high**. The suspect |
| old13 | old_messages | partial | true | search search search search search search search search search | Nie znalazłem w Flux grafiku dyżurów na przerwę wakacyjną ani świąteczną. Najbliższe wzmianki dotyczą innych o |
| old14 | old_messages | correct | true | search search search search | Firmware releases are now approved by Marta Wiśniewska. You set this in the Czujniki space on 15 October 2026, |
| old15 | old_messages | correct | true | search search | Według Flux telefon do inż. Haliny Kurek to 58 323 11 47. Ada napisała to 18 czerwca w przestrzeni „Klient: Mi |
| win01 | recent | correct | true | search search read_around | Dziś jest piątek, więc stand-up się nie odbywa. Ada zapowiedziała w tym wątku, że od przyszłego tygodnia stand |
| win02 | recent | correct | true | - | The stations reboot about every 49.7 days because the firmware's `millis()` counter overflows. Jonas Berg foun |
| wiki01 | wiki | correct | true | search search | Klient ma **30 dni od dostawy** na zgłoszenie zwrotu stacji. Wynika to z wiki "Procedura zwrotów (RMA)" w prze |
| wiki02 | wiki | correct | true | search search search get_doc | Our core working hours are 10:00 to 14:00. The wiki page "Onboarding: the first week" in the Firma space says  |
| wiki03 | wiki | correct | true | search search get_doc | Według wiki w przestrzeni Czujniki test wygrzewania trwa **72 godziny** na 20 stacjach w stanowisku testowym,  |
| wiki04 | wiki | correct | true | search search search | Według dokumentu **"Cennik i rabaty 2027"** w przestrzeni Dostawy i logistyka (Bogdan Kowalski) transport jest |
| wiki05 | wiki | correct | true | search search search | Roof installations should not go ahead in wind above **12 m/s**, according to the wiki page "Montaż na dachu:  |
| wiki06 | wiki | correct | true | search search search search search | Do nagłówków na stronie używamy kroju **Fraunces**, a tekst główny jest w kroju **Inter**. Według wiki „Brand  |
| wiki07 | wiki | correct | true | search search search get_doc | According to the wiki page "Gdańsk: SLA i kontakty" in the Klient: Miasto Gdańsk space, you must respond to a  |
| wiki08 | wiki | correct | true | search search search get_doc | Urlop zgłaszamy co najmniej **14 dni wcześniej** w Kadromierzu. Tak stoi na wiki w przestrzeni Firma, na stron |
| file01 | file | dont_know | false | search search read_around search | Nie znalazłem w Flux ceny obudowy z oferty Plastmetu. Jest tylko plik `Oferta_Plastmet_obudowy.pdf` (1 strona) |
| file02 | file | dont_know | false | search search read_around search search list_materials | I can't tell you the cause from the post-mortem itself. It is attached to Piotr Zieliński's message in the Czu |
| file03 | file | dont_know | false | search search read_around list_materials search | Nie mogę odczytać tej wartości. Plik `pomiary_ST-0417.csv` (30 wierszy) został dołączony przez Tomasza Wójcika |
| file04 | file | dont_know | false | search search search read_around | I can't find the contractual penalty in Flux. The only NDA with Sopot I found is `NDA_Sopot.docx`, attached to |
| file05 | file | dont_know | false | search search read_around search search search search read_around search | Nie znalazłem w Flux wartości marginesu emisji promieniowanej. Najbliższy trop to raport EMC z laboratorium w  |
| file06 | file | dont_know | false | search list_contexts search search | I couldn't find station ST-0433 in Flux. Searches for "ST-0433" and "0433" returned nothing. The only station  |
| tdm01 | task_decision_map | correct | true | search search get_work get_task_discussion | Według Flux zamówiono **25 anten Taoglas FXP290**. Zamówiła je Ola Lewandowska (wątek zadania #1 w Klient: Mia |
| tdm02 | task_decision_map | correct | true | search search | Phoenix Testlab quoted **18,400 EUR** for the RED tests, six weeks from sample delivery. Jonas Berg posted thi |
| tdm03 | task_decision_map | correct | true | search search get_work read_around | Według Flux użyjecie **Better Stack**. Sarah Mitchell napisała to 29 października w projekcie Website relaunch |
| tdm04 | task_decision_map | correct | true | search search | The accepted decision "Gwarancja 36 miesięcy dla klientów samorządowych" in the Klient: Miasto Gdańsk space se |
| tdm05 | task_decision_map | correct | true | search search search | W rewizji D złączem serwisowym ma być **USB-C**, jako jedyny port serwisowy. Wynika to z zaakceptowanej decyzj |
| tdm06 | task_decision_map | correct | true | search search get_map | W mapie „Pomysły na 2027” w przestrzeni Czujniki jest zapisane, że abonament na dane kosztowałby 9 zł miesięcz |
| tdm07 | task_decision_map | correct | true | search list_maps get_map | The "Website ideas" map in the Website relaunch space says the live map of every public station refreshes ever |
| two01 | two_source | correct | true | search search search get_doc read_around | Przy zamówieniu 60 sztuk samorząd zapłaciłby około **1 096,50 zł netto za stację**, czyli około **65 790 zł ne |
| two02 | two_source | partial | true | search search get_doc search search search | The soak test is **72 hours** on 20 stations in the test rack before wave 1. That comes from the "Firmware rel |
| two03 | two_source | partial | false | search search get_doc search | Na czas reakcji odpowiadacie w ciągu **48 godzin** od zgłoszenia awarii przez miasto. Wynika to z dokumentu „G |
| two04 | two_source | partial | false | search search search search search | I couldn't find a start date for the new embedded developer in Flux. Searches turned up only recruiting messag |
| two05 | two_source | correct | true | search search search get_doc get_decision | Gwarancja dla samorządów to co najmniej 36 miesięcy: decyzja „Gwarancja 36 miesięcy dla klientów samorządowych |
| two06 | two_source | wrong (input_too_large) | false | search search get_work read_around search search search search |  |
| two07 | two_source | partial | false | search search search read_around read_around search search | I couldn't find the price of one Plastmet enclosure as text in Flux. The offer is attached to Bogdan Kowalski' |
| rel01 | relative_date | correct | true | search search read_around | Ustaliliście budżet marketingowy na pierwszy kwartał: **42 000 zł**, z czego połowa idzie na targi. Napisał to |
| rel02 | relative_date | wrong | false | search search search search search | I couldn't find anything from Maurycy about a supplier in early October in Flux. Searches for his name and for |
| rel03 | relative_date | correct | - | summarize | W zeszłym tygodniu (pon. 2 – niedz. 8 listopada) w przestrzeni było 41 wiadomości. Najważniejsze: - **Wysyłki  |
| rel04 | relative_date | correct | true | search search | The message is from Ola Lewandowska on 13 September 2026 in the Dostawy i logistyka space. It reads: "Faktura  |
| rel05 | relative_date | correct | true | search search search read_around | W miniony weekend (7–8 listopada) dyżur miał Jonas Berg. Wynika to z wiadomości Piotra Zielińskiego w Czujnika |
| rel06 | relative_date | correct | true | search search search read_around search search | According to Piotr Zieliński's message on 3 October 2026 in the Czujniki space, **firmware 2.6** passed testin |
| rel07 | relative_date | correct | true | search search search read_around | W październiku wysłaliśmy do Gdańska **18 stacji**. Ola Lewandowska napisała o tym 14 października w rozmowie  |
| rel08 | relative_date | correct | - | summarize | Last week (Mon 2 to Sun 8 November) the space had 30 messages, and the digest covers all of them. The main thr |
| rel09 | relative_date | correct | true | search search | Sarah Mitchell napisała 23 października 2026 w Website relaunch, że nowa strona przeszła audyt dostępności z w |
| rel10 | relative_date | correct | true | search search | Maurycy Lis podał 15 października 2026 w Dostawach i logistyce, że morski fracht z Shenzhen wynosi **2 950 USD |
| none01 | no_answer | correct | - | search search search search | Nie znalazłem NIP-u firmy Plastmet w Flux. Wyszukiwanie po „NIP”, „Plastmet” i w wiki nie dało żadnego wpisu z |
| none02 | no_answer | correct | - | search search search search | I couldn't find the Wi-Fi password in Flux. I searched for "Wi-Fi", "wifi", "password" and "new office network |
| none03 | no_answer | correct | - | search search search search search search search | Nie znalazłem w Flux kwoty wydatków na reklamy na LinkedInie za październik. Przeszukałem wiadomości, zadania  |
| none04 | no_answer | correct | - | search search search search get_doc search search search | I couldn't find a phone number for Tomasz Wójcik in Flux. I searched for his name in several forms (including  |
| none05 | no_answer | correct | - | search search search search search search | Nie znalazłem w Flux niczego o umowie z Krakowem na stacje. Szukałem po słowach „Kraków”, „Krakowem”, „umowa”  |
| none06 | no_answer | correct | - | search search search search search search | I couldn't find any record of an ATEX certificate or the body that issued it in the Flux spaces you can see. I |
| none07 | no_answer | correct | - | search search search search search | Nie znalazłem w Flux numeru konta bankowego Eurocircuits. Są tam wiadomości o fakturach od Eurocircuits (np. F |
