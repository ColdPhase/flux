#!/usr/bin/env python3
"""The retrieval bench's seeded space (#1242): one company, 8 people, one agent, 6 spaces, 7 conversations, 10,000 messages in
Polish and English, with the known-answer facts and distractors of facts.json placed among ordinary work chatter.

Deterministic: the same seed gives the same messages, ids and test set. Standard library only.

  python3 seed.py --out out/seed.json [--messages 10000] [--seed 1242]

The output holds the people, spaces, grants, conversations, messages (id, conversation, sequence, author, time, body, lang, fact key)
and the test set with each question's gold message ids. It is the input of harness.py and can be loaded into a real Flux later.
"""
import argparse
import datetime as dt
import json
import random
import uuid
from pathlib import Path

NS = uuid.UUID("5b1d6a4e-1242-4c0e-9d1e-000000001242")
HERE = Path(__file__).resolve().parent
START = dt.datetime(2026, 3, 2, 8, 0)
END = dt.datetime(2026, 11, 10, 18, 0)


def uid(*parts):
    return str(uuid.uuid5(NS, "/".join(parts)))


PEOPLE = {
    "ada": ("Ada Nowak", "owner"), "bogdan": ("Bogdan Kowalski", "admin"), "marta": ("Marta Wiśniewska", "member"),
    "piotr": ("Piotr Zieliński", "member"), "ola": ("Ola Lewandowska", "member"), "jonas": ("Jonas Berg", "member"),
    "sarah": ("Sarah Mitchell", "member"), "tomasz": ("Tomasz Wójcik", "guest"),
}
AGENTS = {"fieldbot": ("Fieldbot", "ada")}
# visibility, grants (person -> role); a guest reads only spaces they were added to.
SPACES = {
    "czujniki": ("Czujniki", "workspace", {}),
    "dostawy": ("Dostawy i logistyka", "workspace", {}),
    "www": ("Website relaunch", "workspace", {}),
    "rekrutacja": ("Rekrutacja", "restricted", {"ada": "contributor", "marta": "contributor"}),
    "zarzad": ("Zarząd", "restricted", {"ada": "contributor", "bogdan": "contributor"}),
    "gdansk": ("Klient: Miasto Gdańsk", "workspace", {"tomasz": "contributor"}),
}
# conversation -> (space, share of the 10k messages, share of Polish, author weights)
CONVERSATIONS = {
    "czujniki-main": ("czujniki", 0.50, 0.75, {"ada": 3, "piotr": 4, "jonas": 3, "marta": 2, "ola": 2, "bogdan": 1}),
    "czujniki-kalibracja": ("czujniki", 0.08, 0.92, {"marta": 5, "piotr": 3, "jonas": 1}),
    "dostawy-main": ("dostawy", 0.15, 0.62, {"bogdan": 3, "ola": 4, "sarah": 3, "piotr": 2}),
    "www-main": ("www", 0.12, 0.15, {"sarah": 4, "jonas": 4, "ada": 1, "bogdan": 1}),
    "rek-main": ("rekrutacja", 0.04, 0.97, {"marta": 4, "ada": 2}),
    "zarzad-main": ("zarzad", 0.05, 0.97, {"ada": 3, "bogdan": 3}),
    "gdansk-main": ("gdansk", 0.06, 0.95, {"ada": 2, "tomasz": 4, "ola": 2, "piotr": 1}),
}

# Ordinary chatter. Slots are filled from the lists below; Polish slots carry their grammatical case in the name.
PL_COMMON = [
    "ok", "jasne", "dzięki!", "👍", "+1", "zrobione", "sprawdzę po obiedzie", "jestem na spotkaniu, odpiszę później",
    "Ktoś widział {person_acc} dzisiaj?", "Wrzuciłem notatki ze spotkania do dokumentu.", "Mam problem z VPN, ktoś pomoże?",
    "Przypominam o jutrzejszym spotkaniu o {hour}.", "Czy możemy przełożyć rozmowę na {weekday_acc}?", "Dobra robota wszystkim w tym tygodniu!",
    "Wyślę podsumowanie do końca dnia.", "Kto ma dostęp do konta firmowego na {service}?", "Zamówiłem kawę do biura, będzie w {weekday_loc}.",
    "Jutro pracuję zdalnie.", "Biorę urlop {dayrange_pl} {month_gen}.", "Czy ktoś pamięta, gdzie leży instrukcja do {service_gen}?",
]
EN_COMMON = [
    "ok", "sounds good", "thanks!", "👍", "on it", "done", "will check after lunch", "in a meeting, back in 20",
    "Has anyone seen {person_en} today?", "Pushed the meeting notes to the doc.", "VPN is acting up again, anyone else?",
    "Reminder: sync tomorrow at {hour}.", "Can we move the call to {weekday_en}?", "Great work this week, everyone!",
    "I'll send a recap by end of day.", "Who has the login for the company {service} account?", "Out tomorrow, ping me on the phone if urgent.",
    "Taking {dayrange_en} {month_en} off.", "Does anyone remember where the {service} docs live?",
]
TOPIC = {
    "czujniki": {
        "pl": [
            "Wgrałem nową wersję firmware {fw} na {n} {station_gen_pl} testowych.", "Na stacji w {site_loc} znowu brak danych od {n} godzin.",
            "Czy ktoś sprawdzał pobór prądu {thing_gen} w trybie uśpienia?", "Wymieniłem {thing_acc} na stacji w {site_loc}, działa.",
            "Pomiar {measure_gen} na {site_loc} skacze o {n}%, sprawdzę kabel.", "Kalibracja {thing_gen} jutro rano, potrzebuję komory.",
            "Bramka LoRaWAN zgubiła {n} pakietów w nocy, ale rano wróciła.", "Dodałem wykres {measure_gen} do panelu klienta.",
            "Po aktualizacji {fw} stacje wysyłają dane co {n} minut.", "Mamy {n} {station_gen_pl} offline, większość na {site_loc}.",
            "Czy {person_nom} może przejrzeć PR z obsługą {thing_gen}?", "Testuję nowy {thing_acc_m} od {supplier_gen}, pierwsze wyniki dobre.",
            "Bateria na stacji w {site_loc} spadła do {n}%, trzeba podjechać.", "Zmieniam interwał pomiaru {measure_gen} na {n} minut na próbę.",
            "Montaż na dachu {site_gen} przesunięty na {weekday_acc} przez deszcz.", "Wilgotność na {site_loc} pokazuje bzdury, chyba zalany czujnik.",
            "Zapisałem wyniki testu {thing_gen} w arkuszu, zakładka {n}.", "Czy w nowej wersji stacji zostawiamy {thing_acc}?",
            "Firmware {fw} ma regresję w obsłudze {thing_gen}, cofam na próbę.", "Ktoś zamawiał już {thing_acc} na kolejną serię?",
            "Stacja {site_gen} restartuje się co kilka godzin, zbieram logi.", "Czujniki temperatury na {site_loc} różnią się o {n} stopnie.",
        ],
        "en": [
            "Flashed firmware {fw} on {n} test units.", "Station at {site_en} has been silent for {n} hours.",
            "Did anyone measure the {thing_en} sleep current?", "Swapped the {thing_en} on the {site_en} unit, it's back.",
            "The {measure_en} reading at {site_en} jumps by {n}%, checking the cable.", "Added a {measure_en} chart to the customer dashboard.",
            "After {fw} the units report every {n} minutes.", "{n} stations offline, mostly around {site_en}.",
            "Can {person_en} review the PR for the {thing_en} driver?", "The LoRa gateway dropped {n} packets overnight, fine this morning.",
            "Opened an issue for the {thing_en} timeout in {fw}.", "Cloud ingest lag is {n} seconds today, looking into it.",
            "Should the next station version keep the {thing_en}?", "Battery on the {site_en} unit is at {n}%, someone needs to drive out.",
        ],
    },
    "dostawy": {
        "pl": [
            "Dostawa {part_gen} od {supplier_gen} przyjdzie w {weekday_acc}.", "Faktura od {supplier_gen} zaksięgowana.",
            "Kurier nie odebrał paczki, zamawiam ponownie na {weekday_acc}.", "W magazynie zostało {n} {part_gen_pl}.",
            "Zamówiłem {n} sztuk {part_gen} u {supplier_gen}.", "Paczka do klienta wyszła, numer przesyłki w arkuszu.",
            "{supplier_nom} podnosi ceny od przyszłego miesiąca o {n}%.", "Czy mamy jeszcze {part_acc} na stanie?",
            "Odprawa celna trwa już {n} dni, dzwonię do agencji.", "Wysyłka {n} stacji do klienta w {weekday_loc}.",
            "Inwentaryzacja w {weekday_loc}, potrzebuję dwóch osób.", "Reklamacja do {supplier_gen} wysłana, czekamy na odpowiedź.",
        ],
        "en": [
            "{part_en} delivery from {supplier_en} lands on {weekday_en}.", "Invoice from {supplier_en} is booked.",
            "We have {n} {part_en} left in stock.", "Ordered {n} pcs of {part_en} from {supplier_en}.",
            "{supplier_en} raises prices by {n}% next month.", "Customs clearance is on day {n}, calling the broker.",
            "Shipment of {n} stations goes out on {weekday_en}.", "Complaint sent to {supplier_en}, waiting for an answer.",
        ],
    },
    "www": {
        "pl": ["Poprawiłem tłumaczenie strony {page_gen}.", "Czy zdjęcia stacji na stronę są już gotowe?", "Formularz kontaktowy znowu łapie spam."],
        "en": [
            "Updated the {page_en} page copy.", "The {page_en} page loads in {n} seconds on mobile, needs work.",
            "New hero image for the {page_en} page is in Figma.", "Staging is down again, redeploying.",
            "SEO audit flagged {n} broken links on the {page_en} page.", "Can {person_en} proofread the {page_en} page?",
            "Moved the {page_en} page under /product.", "Contact form is catching spam again.", "Lighthouse score for {page_en}: {n}.",
            "Who owns the blog post about {topic_en}?", "Cookie text needs a lawyer's look before launch.",
        ],
    },
    "rekrutacja": {
        "pl": ["Ogłoszenie na {role_acc} wisi na {portal}.", "Mamy {n} CV na {role_acc}, przeglądam.", "Rozmowa z kandydatem na {role_acc} w {weekday_acc} o {hour}.",
               "Kandydat na {role_acc} odrzucił ofertę.", "Zadanie rekrutacyjne na {role_acc} do poprawy.", "Referencje kandydata na {role_acc} sprawdzone."],
        "en": ["Interview for the {role_en} role on {weekday_en} at {hour}."],
    },
    "zarzad": {
        "pl": ["Budżet na {quarter} do przejrzenia przed {weekday_inst}.", "Wynik finansowy za {month_acc} lepszy o {n}% od planu.", "Spotkanie zarządu w {weekday_acc} o {hour}.",
               "Przegląd umów z dostawcami w przyszłym tygodniu.", "Rozmowa z bankiem o linii kredytowej w {weekday_loc}.", "Cash flow na {quarter} wygląda dobrze.",
               "Księgowa prosi o dokumenty za {month_acc}.", "Rozważamy podwyżki od {quarter}."],
        "en": ["Board deck draft is in the shared folder."],
    },
    "gdansk": {
        "pl": ["Montaż na przystanku {stop_nom} zakończony.", "Na przystanku {stop_nom} stacja nie zgłasza się do sieci.", "Miasto prosi o raport z {n} stacji za {month_acc}.",
               "Spotkanie z ZTM w {weekday_acc} o {hour}.", "Zdjęcia montażu na {stop_loc} wrzucone do folderu.", "Ekipa jutro na {stop_loc}, {n} stacji do zamontowania.",
               "Klient pyta o dostęp do panelu dla {n} osób.", "Wysłałem miastu protokół odbioru z {stop_gen}."],
        "en": ["City sent the acceptance protocol template."],
    },
}
SLOTS = {
    "person_acc": ["Piotra", "Martę", "Olę", "Jonasa", "Bogdana", "Adę"], "person_nom": ["Piotr", "Marta", "Ola", "Jonas", "Bogdan"],
    "person_en": ["Piotr", "Marta", "Ola", "Jonas", "Sarah", "Bogdan"], "hour": ["9:00", "10:30", "11:00", "13:00", "14:15", "15:30"],
    "weekday_acc": ["poniedziałek", "wtorek", "środę", "czwartek", "piątek"], "weekday_loc": ["poniedziałek", "wtorek", "środę", "czwartek", "piątek"],
    "weekday_inst": ["poniedziałkiem", "wtorkiem", "środą", "czwartkiem", "piątkiem"], "weekday_en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "service": ["GitHub", "Slack", "OVH", "Figma", "Google Workspace", "Hetzner"], "service_gen": ["drukarki", "routera", "lutownicy", "komory klimatycznej", "oscyloskopu"],
    "dayrange_pl": ["od 3 do 5", "od 7 do 9", "od 12 do 16", "od 19 do 23"], "dayrange_en": ["3 to 5", "7 to 9", "12 to 16", "19 to 23"], "month_gen": ["kwietnia", "maja", "czerwca", "lipca", "sierpnia", "października"],
    "month_en": ["April", "May", "June", "July", "August", "October"], "month_acc": ["marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik"],
    "fw": ["2.1.4", "2.2.0", "2.2.3", "2.3.0", "2.3.1", "2.3.2", "2.4.1", "2.4.3", "2.5.0", "2.5.1"],
    "station_gen_pl": ["stacjach", "stacjach", "urządzeniach"], "n": [str(i) for i in (2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 30, 40)],
    "site_loc": ["Oliwie", "Wrzeszczu", "Zaspie", "Przymorzu", "Śródmieściu", "Sopocie", "Gdyni", "Pruszczu", "Grunwaldzkiej", "Morenie"],
    "site_gen": ["Oliwy", "Wrzeszcza", "Zaspy", "Przymorza", "Śródmieścia", "Sopotu", "Gdyni", "Moreny", "biurowca", "szkoły"],
    "site_en": ["Oliwa", "Wrzeszcz", "Zaspa", "Przymorze", "Sopot", "Gdynia", "Pruszcz", "Morena"],
    "thing_gen": ["czujnika", "bramki", "obudowy", "baterii", "płytki", "anteny", "modemu", "panelu słonecznego", "zasilacza", "czujnika gleby"],
    "thing_acc": ["czujnik", "bramkę", "obudowę", "baterię", "płytkę", "antenę", "modem", "panel słoneczny", "zasilacz", "uszczelkę"],
    "thing_acc_m": ["czujnik", "modem", "zasilacz", "panel", "dławik"],
    "thing_en": ["sensor", "gateway", "enclosure", "battery", "board", "antenna", "modem", "solar panel", "power supply", "soil probe"],
    "measure_gen": ["temperatury", "wilgotności", "ciśnienia", "pyłu PM2.5", "wilgotności gleby", "napięcia baterii"],
    "measure_en": ["temperature", "humidity", "pressure", "PM2.5", "soil moisture", "battery voltage"],
    "supplier_gen": ["TME", "Farnella", "Plastmetu", "Ecoprimy", "Satel-Techu", "Mousera", "Eurocircuits", "DigiKey"],
    "supplier_nom": ["TME", "Farnell", "Plastmet", "Ecoprima", "Mouser", "DigiKey"], "supplier_en": ["TME", "Farnell", "Plastmet", "Ecoprima", "Mouser", "DigiKey", "Eurocircuits"],
    "part_gen": ["obudów", "akumulatorów", "anten", "płytek", "dławików", "uszczelek", "paneli", "kabli"], "part_gen_pl": ["obudów", "akumulatorów", "anten", "płytek", "dławików"],
    "part_acc": ["obudowy", "akumulatory", "anteny", "płytki", "dławiki", "uszczelki"], "part_en": ["enclosures", "batteries", "antennas", "boards", "cable glands", "gaskets"],
    "page_gen": ["głównej", "cennika", "o nas", "kontaktu"], "page_en": ["home", "pricing", "about", "contact", "product", "careers"],
    "topic_en": ["air quality", "green roofs", "smart cities", "LoRaWAN"], "role_acc": ["embedded developera", "QA", "backend developera", "handlowca"],
    "role_en": ["embedded", "QA", "backend", "sales"], "portal": ["Pracuj.pl", "NoFluffJobs", "LinkedIn", "JustJoinIT"],
    "quarter": ["Q2", "Q3", "Q4", "Q1 2027"], "stop_nom": ["Brama Wyżynna", "Hucisko", "Zabianka", "Oliwa PKP", "Jaśkowa Dolina", "Przymorze Wielkie"],
    "stop_loc": ["Bramie Wyżynnej", "Hucisku", "Zabiance", "Oliwie PKP", "Jaśkowej Dolinie", "Przymorzu Wielkim"],
    "stop_gen": ["Bramy Wyżynnej", "Huciska", "Zabianki", "Oliwy PKP", "Jaśkowej Doliny", "Przymorza Wielkiego"],
}


def fill(rng, template):
    out = template
    while "{" in out:
        start = out.index("{"); stop = out.index("}", start)
        out = out[:start] + rng.choice(SLOTS[out[start + 1:stop]]) + out[stop + 1:]
    return out


# Openers and closers people add, so that the same template rarely gives the same message twice.
OPEN = {"pl": ["", "", "", "Hej, ", "Szybko: ", "FYI ", "@Piotr ", "@Marta ", "@Ola ", "Uwaga: ", "Info: ", "Btw. "],
        "en": ["", "", "", "Hey, ", "Quick one: ", "FYI ", "@Jonas ", "@Sarah ", "Heads up: ", "Btw, "]}
CLOSE = {"pl": ["", "", "", " Dajcie znać.", " Zdjęcie w wątku.", " Wracam do tego jutro.", " Dzięki!", " (szczegóły w arkuszu)", " Co myślicie?"],
         "en": ["", "", "", " Let me know.", " Photo in the thread.", " Will follow up tomorrow.", " Thanks!", " (details in the sheet)", " Thoughts?"]}


def chatter(rng, space, polish):
    lang = "pl" if polish else "en"
    common = PL_COMMON if polish else EN_COMMON
    topic = TOPIC[space][lang]
    text = fill(rng, rng.choice(common if rng.random() < 0.3 else topic))
    # Some messages are two sentences, as people write.
    if rng.random() < 0.25:
        second = fill(rng, rng.choice(topic))
        if second.split()[0] != text.split()[0]:
            text += " " + second
    if len(text) > 12:
        text = rng.choice(OPEN[lang]) + text + rng.choice(CLOSE[lang])
    return text, lang


def working_time(rng, start, end):
    while True:
        moment = start + dt.timedelta(seconds=rng.uniform(0, (end - start).total_seconds()))
        if moment.weekday() < 5 and 7 <= moment.hour < 19:
            return moment.replace(microsecond=0)


def build(total, seed):
    rng = random.Random(seed)
    facts = json.loads((HERE / "facts.json").read_text())
    planted = {}  # conversation -> [(time, author, text, lang, fact key, extra)]
    for fact in facts["facts"]:
        lang = "en" if fact["author"] in ("jonas", "sarah") and not any(c in fact["text"] for c in "ąęłńóśźżć") else "pl"
        planted.setdefault(fact["conv"], []).append((dt.datetime.fromisoformat(fact["at"]), fact["author"], fact["text"], lang, fact["key"], fact))
        for number, distractor in enumerate(fact.get("distractors", [])):
            planted[fact["conv"]].append((dt.datetime.fromisoformat(distractor["at"]), distractor["author"], distractor["text"], "pl" if any(c in distractor["text"] for c in "ąęłńóśźżć") or " w " in distractor["text"] else "en", f"{fact['key']}~{number}", None))
    messages = []
    for conv, (space, share, polish, weights) in CONVERSATIONS.items():
        mine = planted.get(conv, [])
        count = round(total * share) - len(mine)
        authors = [a for a, w in weights.items() for _ in range(w)]
        rows = []
        # Recent facts must sit inside the last 40 messages: chatter ends before the latest recent fact.
        recent_at = [m[0] for m in mine if m[5] and m[5].get("recent")]
        for _ in range(count):
            text, lang = chatter(rng, space, rng.random() < polish)
            rows.append((working_time(rng, START, END), rng.choice(authors), text, lang, None, None))
        rows += mine
        rows.sort(key=lambda r: r[0])
        for sequence, (at, author, text, lang, key, fact) in enumerate(rows, start=1):
            messages.append({"id": uid("message", conv, str(sequence)), "conversation": conv, "space": space, "sequence": sequence,
                             "author": author, "at": at.isoformat() + "Z", "body": text, "lang": lang, "fact": key,
                             "edited_body": fact.get("edited_text") if fact else None})
        if recent_at:
            last40 = [m["fact"] for m in messages if m["conversation"] == conv][-40:]
            for m in mine:
                if m[5] and m[5].get("recent") and m[4] not in last40:
                    raise SystemExit(f"recent fact {m[4]} is outside the last 40 messages of {conv}")
    by_fact = {m["fact"]: m["id"] for m in messages if m["fact"]}
    questions = []
    for q in facts["questions"]:
        questions.append({**q, "gold_ids": [by_fact[k] for k in q["gold"]]})
    return {
        "seed": seed, "generated_for": "#1242 retrieval bench",
        "workspace": {"id": uid("workspace"), "name": "Zielony Dach"},
        "people": [{"key": k, "id": uid("person", k), "name": n, "role": r} for k, (n, r) in PEOPLE.items()],
        "agents": [{"key": k, "id": uid("agent", k), "name": n, "owner": o} for k, (n, o) in AGENTS.items()],
        "spaces": [{"key": k, "id": uid("space", k), "name": n, "visibility": v, "grants": g} for k, (n, v, g) in SPACES.items()],
        "conversations": [{"key": k, "id": uid("conversation", k), "space": s} for k, (s, *_rest) in CONVERSATIONS.items()],
        "messages": messages,
        "questions": questions,
        "access_checks": facts["access_checks"],
        "deletion_checks": facts["deletion_checks"],
        "facts": {m["fact"]: m["id"] for m in messages if m["fact"]},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(HERE / "out" / "seed.json"))
    parser.add_argument("--messages", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=1242)
    args = parser.parse_args()
    data = build(args.messages, args.seed)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=0))
    langs = {}
    for m in data["messages"]:
        langs[m["lang"]] = langs.get(m["lang"], 0) + 1
    print(f"messages {len(data['messages'])} · questions {len(data['questions'])} · languages {langs} · out {args.out}")


if __name__ == "__main__":
    main()
