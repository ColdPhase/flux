"""recall@10 of a runner output (jsonl), against the review's live lists and (optionally) the Python model with params."""
import json, sys
seed = json.load(open('seed.json')); Q = {q['id']: q for q in seed['questions']}
TUNE = {i for i in Q if int(i[1:]) % 2 == 1}
rows = [json.loads(l) for l in open(sys.argv[1])]
def rec(ids, q): t = set(ids[:10]); return sum(g in t for g in q['gold_ids']) / len(q['gold_ids'])
by = {}
for r in rows: by.setdefault(r['form'], {})[r['q']] = rec(r['lex'], Q[r['q']])
for f, m in by.items():
    a = lambda ids: round(sum(m[i] for i in ids) / len(ids), 3)
    print(f, 'tune', a([i for i in m if i in TUNE]), 'held', a([i for i in m if i not in TUNE]), 'all', a(list(m)))
