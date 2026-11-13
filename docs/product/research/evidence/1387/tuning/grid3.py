import sys, itertools, json
sys.argv = ['x', 'seed.json', 'cache.json', '../review-lists.json']
exec(open('tune.py').read().split("if __name__")[0])
rows = []
for rule, dl, k1, b in itertools.product(('exact', 'bounded1', 'bounded2', 'bounded3', 'prefix'), ('distinct', 'tokens'), (0.9, 1.2), (0.1, 0.2, 0.3, 0.5, 0.75)):
    P = {**BASE, 'tf': 'stem', 'rule': rule, 'dl': dl, 'k1': k1, 'b': b}
    r = {f: evaluate(P, f)[0] for f in ('question', 'keywords', 'bilingual')}
    rows.append((P, r))
json.dump(rows, open('grid3.json', 'w'))
rows.sort(key=lambda pr: (sum(pr[1][f]['bm25']['tune'] for f in pr[1]), pr[1]['question']['bm25']['tune']), reverse=True)
for P, r in rows:
    print({k: P[k] for k in ('rule','dl','k1','b')}, ' '.join(f"{f[:4]} {r[f]['bm25']['tune']:.3f}/{r[f]['bm25']['held']:.3f}/{r[f]['bm25']['all']:.3f} h {r[f]['hybrid']['held']:.3f}/{r[f]['hybrid']['all']:.3f}" for f in r))
