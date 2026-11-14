# Answer accuracy (#1295): claude-haiku-5-5, variant main, pi-1441-1

Flux b9e9cf168 (main; harness e205a00ab) · 2026-11-13 · 62 questions · judge claude-haiku-5-5 · web search off · spend $0.1879 agent + $0.0086 judge

| Category | n | Accuracy | Correct / partial / wrong / don't know | Runs without an answer | Keys | Gold source read | Answer in tool results | Cited (named) gold | Date filter | In tok/q | Out tok/q | $/q | p50 / p95 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.933 | 13 / 2 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (0) | - | 9 | 990 | 0.00348 | 7.1 / 13.1 |
| recent | 2 | 1 | 2 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (0) | - | 7 | 817 | 0.00391 | 7 / 7 |
| wiki | 8 | 0.875 | 7 / 0 / 0 / 1 | 0 | 0.875 | 0.875 | 0.875 | 0 (0.875) | - | 9 | 691 | 0.00249 | 6.1 / 8.1 |
| file | 6 | 1 | 6 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0 (1) | - | 8 | 549 | 0.00212 | 6.1 / 7.1 |
| task_decision_map | 7 | 1 | 7 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 0.286 (0.857) | - | 8 | 683 | 0.00204 | 6.1 / 8.1 |
| two_source | 7 | 0.929 | 6 / 1 / 0 / 0 | 0 | 0.857 | 1 | 0.857 | 0 (0.714) | - | 10 | 1442 | 0.00418 | 9.1 / 15.1 |
| relative_date | 10 | 0.85 | 8 / 1 / 0 / 1 | 0 | 0.875 | 0.9 | 0.875 | 0 (0) | 0.7 | 8 | 1024 | 0.00275 | 8.1 / 14.1 |
| no_answer | 7 | 1 | 7 / 0 / 0 / 0 | 0 | - | - | - | - (-) | - | 11 | 1048 | 0.00345 | 8.2 / 10.2 |
| **all** | 62 | 0.935 | 56 / 4 / 0 / 2 | 0 | 0.943 | 0.964 | 0.943 | 0.036 (0.436) | 0.7 | 9 | 932 | 0.00303 | 7.1 / 11.1 |

| Question | Category | Verdict | Keys | Tools | Answer (start) |
| --- | --- | --- | --- | --- | --- |
| old01 | old_messages | correct | true | search search search | Numer zamówienia SHT45 w TME to **TME-2026-04471**. Bogdan Kowalski zapisał go w przestrzeni Czujniki 14 kwiet |
| old02 | old_messages | correct | true | search search search read_around | Piotr Zieliński reported in May that a station measuring every 10 minutes lasted **14 months** on two 18650 ce |
| old03 | old_messages | correct | true | search search read_around search | W Flux znalazłam jeden konkretny wynik: po kalibracji w komorze klimatycznej Marta Wiśniewska napisała 3 czerw |
| old04 | old_messages | correct | true | search search read_around | Według Flux bramka LoRaWAN na dachu biurowca przy Grunwaldzkiej ma zasięg około 2,7 km. Zmierzył to Piotr Ziel |
| old05 | old_messages | correct | true | search search search search search search read_around | The investment fund is Black Pine. On 2 October 2026 you wrote in the Zarząd space that it wanted to invest 2. |
| old06 | old_messages | partial | true | search search search read_around search search search search search | Według Flux decyzja z 27 maja 2026 (Sarah Mitchell, space Dostawy i logistyka) przenosiła montaż PCB z Satel-T |
| old07 | old_messages | correct | true | search search search search summarize search search | Ostatni zapisany stan to **12 kompletnych stacji** w magazynie w Pruszczu, z 30 września (Piotr Zieliński, #Do |
| old08 | old_messages | correct | true | search search search search search read_around search | The site uses **Payload** as its CMS. Jonas Berg wrote in the Website relaunch chat on 14 May 2026 that the te |
| old09 | old_messages | correct | true | search search get_doc | The contract penalty in Flux is **0.2% for each day of delay** on the Gdańsk contract. A message you wrote on  |
| old10 | old_messages | correct | true | search search search read_around | Według notatki Piotra Zielińskiego z 15 lipca 2026 w przestrzeni Czujniki, panel 6 W wystarcza do całorocznej  |
| old11 | old_messages | correct | true | search search search search search read_around | Według Twojej wiadomości w przestrzeni Zarząd z 12 września 2026 biuro przenosi się na **ul. Garbary 8**, od * |
| old12 | old_messages | correct | true | search search search search search read_around search | The city reported that 4 stations in Przymorze show temperatures 5 °C too high. Ada's note in Klient: Miasto G |
| old13 | old_messages | partial | true | search search search search search search | Nie znalazłem w Flux informacji o dyżurze na czas przerwy wakacyjnej ani świątecznej. Najbliższe wpisy to dyżu |
| old14 | old_messages | correct | true | search search search search read_around | Wydania firmware zatwierdza teraz Marta Wiśniewska. Tak zapisałaś w czacie Czujniki 15 października 2026 (wiad |
| old15 | old_messages | correct | true | search search search read_around | Halina Kurek (the spelling in Flux is "Kurek", not "Kurrek") has the phone number 58 323 11 47. Ada Nowak wrot |
| win01 | recent | correct | true | get_conversation search | Dziś jest piątek, więc stand-up się nie odbywa. Według Twojej wiadomości z 9 listopada stand-up przenosi się o |
| win02 | recent | correct | true | get_conversation search read_around | Jonas Berg found the cause on 10 November: the units reboot every 49.7 days because the `millis()` counter ove |
| wiki01 | wiki | correct | true | search search search | Klient ma **30 dni** od dostawy na zgłoszenie zwrotu stacji. Wynika to z wiki "Procedura zwrotów (RMA)" w prze |
| wiki02 | wiki | correct | true | search search search get_doc | Our core hours are 10:00 to 14:00, according to the "Onboarding: the first week" wiki page in the Firma space  |
| wiki03 | wiki | correct | true | search search search get_doc | Test wygrzewania trwa 72 godziny. Według checklisty „Firmware release checklist” w Czujnikach (wiki, wersja 1, |
| wiki04 | wiki | correct | true | search search search get_doc | Transport is free from **20 pieces**, according to the wiki page "Cennik i rabaty 2027" (Dostawy i logistyka s |
| wiki05 | wiki | correct | true | search search get_doc | Roof installations are not allowed above a wind speed of **12 m/s**. This comes from the wiki page "Montaż na  |
| wiki06 | wiki | dont_know | false | search search search search search read_around search search | Nie znalazłam w Flux nazwy czcionki używanej do nagłówków. Jedyna wzmianka o czcionkach to wiadomość Jonasa Be |
| wiki07 | wiki | correct | true | search search search get_doc | The wiki page "Gdańsk: SLA i kontakty" in the "Klient: Miasto Gdańsk" space says the response time for a failu |
| wiki08 | wiki | correct | true | search search search get_doc | Według wiki w Firma (strona „Urlopy”) urlop zgłasza się co najmniej **14 dni wcześniej** w Kadromierzu. Ta sam |
| file01 | file | correct | true | search search search read_file | Według oferty Plastmetu nr 2026/311 (plik Oferta_Plastmet_obudowy.pdf w przestrzeni Czujniki, wysłany przez Bo |
| file02 | file | correct | true | search search read_file | According to the post-mortem (postmortem-cloud-outage.md in Czujniki, by Piotr Zieliński), the root cause was  |
| file03 | file | correct | true | search search read_file | Najwyższa temperatura w pliku `pomiary_ST-0417.csv` (przestrzeń „Klient: Miasto Gdańsk”) to **41,3 °C**, zanot |
| file04 | file | correct | true | search search read_file | The NDA with Sopot (NDA_Sopot.docx, in the Zarząd space) sets the contractual penalty in § 5: a party that bre |
| file05 | file | correct | true | search search read_file | Margines emisji promieniowanej w raporcie EMC (plik EMC_report_Gliwice.pdf, raport 2026-EMC-0912, stacja Zielo |
| file06 | file | correct | true | search search read_file | Station ST-0433 is installed at ul. Grunwaldzka 82, at the Jaśkowa Dolina stop, and its installation date is 2 |
| tdm01 | task_decision_map | correct | true | search search search get_work get_task_discussion | Według Flux zamówiono **25 anten Taoglas FXP290**. Ola Lewandowska zapisała to w zadaniu #1 "Wymiana anten w s |
| tdm02 | task_decision_map | correct | true | search search search | Phoenix Testlab quoted 18,400 EUR for the RED tests, with six weeks from sample delivery. Jonas Berg posted th |
| tdm03 | task_decision_map | correct | true | search search search get_task_discussion read_around | Według Flux użyjecie **Better Stack**. Sarah Mitchell zapisała to 29 października w Website relaunch, z adrese |
| tdm04 | task_decision_map | correct | true | search search get_decision search | For municipal customers the warranty is at least 36 months. That is the accepted decision "Gwarancja 36 miesię |
| tdm05 | task_decision_map | correct | true | search search search get_decision | W rewizji D złączem serwisowym ma być USB-C, a jedynym portem serwisowym. Wynika to z zaakceptowanej decyzji „ |
| tdm06 | task_decision_map | correct | true | search search search get_map | Na mapie „Pomysły na 2027” w przestrzeni Czujniki jest Twoja notatka: abonament na dane kosztuje **9 zł miesię |
| tdm07 | task_decision_map | correct | true | list_contexts search get_map search | On the "Website ideas" map in Website relaunch, Sarah Mitchell's card says the live map of every public statio |
| two01 | two_source | correct | true | search search list_contexts get_doc search search | Przy 60 sztukach samorząd zapłaci netto około **1 096,50 zł za stację**, czyli **65 790 zł netto** za całość.  |
| two02 | two_source | correct | true | search search search get_doc search search search | Marta Wiśniewska approves firmware releases. Ada wrote in the Czujniki chat on 15 Oct that from then on Marta  |
| two03 | two_source | correct | true | search search search get_doc search search search | Zgłoszenie awarii z Gdańska trzeba potwierdzić i zacząć reagować w ciągu **48 godzin** od zgłoszenia przez mia |
| two04 | two_source | partial | false | search search get_doc search search search search search search read_around search search | I couldn't find when the new embedded developer starts. Flux has no hire confirmation or start date, only recr |
| two05 | two_source | correct | true | search search search get_doc get_decision search read_around | Gwarancja dla samorządów wynosi według Flux co najmniej 36 miesięcy, a Gdańsk ma w karcie SLA 48 godzin na rea |
| two06 | two_source | correct | true | search search search get_task_discussion read_around | Miasto Gdańsk zgłosiło, że 4 stacje na Przymorzu pokazują temperaturę o 5 stopni za wysoką. Podejrzewacie, że  |
| two07 | two_source | correct | true | search search search read_file read_around | One Plastmet enclosure (model ZD-ENC-3, UV polycarbonate, graphite) is quoted at 23.40 zł net per piece, but o |
| rel01 | relative_date | correct | true | search search read_around | Około półtora miesiąca temu, 30 września 2026, Bogdan Kowalski napisał w rozmowie Zarządu: „Ustaliliśmy budżet |
| rel02 | relative_date | dont_know | false | search search search search search search read_around search | I can't find anything Maurycy said about the supplier in early October. His name doesn't appear in any Flux me |
| rel03 | relative_date | correct | - | summarize get_conversation summarize | W zeszłym tygodniu (pon. 2 – niedz. 8 listopada) w wątku „FYI Jutro pracuję zdalnie.” padło 41 wiadomości. Naj |
| rel04 | relative_date | correct | true | search search | The message is from Ola Lewandowska on 13 Sep 2026 in "Dostawy i logistyka": "Faktura FV/0915/2026 od Eurocirc |
| rel05 | relative_date | partial | true | search search search read_around search | Według Flux dyżur w weekend 7–8 listopada miał Jonas Berg. Wynika to z wiadomości Piotra Zielińskiego w „Czujn |
| rel06 | relative_date | correct | true | search search read_around search | Piotr Zieliński wrote on 3 October 2026 in the Czujniki space that "Firmware 2.6 przeszedł testy na 20 stacjac |
| rel07 | relative_date | correct | true | search search read_around search | W październiku wysłaliśmy do Gdańska **18 stacji**. Wynika to z wiadomości Oli Lewandowskiej z 14 października |
| rel08 | relative_date | correct | - | summarize list_work list_decisions | Last week (Mon 2 to Sun 8 Nov) had 30 messages in the thread and no tasks or decisions. The main work was the  |
| rel09 | relative_date | correct | true | search search search | Sarah Mitchell podała 23 października 2026 w Website relaunch, że nowa strona przeszła audyt dostępności z wyn |
| rel10 | relative_date | correct | true | search search read_around | Maurycy Lis podał 15 października 2026 (w "Dostawy i logistyka") fracht morski z Shenzhen: **2 950 USD za kont |
| none01 | no_answer | correct | - | search search read_file search search search | Nie znalazłem NIP firmy Plastmet w Flux. Wyszukiwanie „NIP” i „Plastmet” nie zwróciło żadnego numeru. Jedyny d |
| none02 | no_answer | correct | - | search search search search search search search search | I couldn't find the Wi-Fi password for the new office in Flux. I searched for "Wi-Fi", "wifi", "password", "SS |
| none03 | no_answer | correct | - | search search search search search search search search search search | Nie znalazłem w Flux informacji o kwocie wydanej na reklamy na LinkedIn w październiku. Przeszukałem wiadomośc |
| none04 | no_answer | correct | - | search search search search search search search get_doc search search | I couldn't find a phone number for Tomasz Wójcik in Flux. I searched for his full name, both with and without  |
| none05 | no_answer | correct | - | search search search search search list_contexts search | Nie znalazłam w Flux żadnej informacji o umowie z Krakowem na stacje. Szukałam po „Kraków”, „Krakow”, „Krakowa |
| none06 | no_answer | correct | - | search search search search search search search search | I couldn't find any ATEX certificate or the body behind it in Flux. I searched in English and Polish for ATEX, |
| none07 | no_answer | correct | - | search search search search search | Nie znalazłem numeru konta bankowego Eurocircuits w Flux. Przeszukałem wiadomości pod hasłami „konto”, „IBAN”, |
