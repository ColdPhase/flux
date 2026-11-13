import sys, itertools, json
sys.argv = ['x', 'seed.json', 'cache.json', '../review-lists.json']
exec(open('tune.py').read().split("if __name__")[0])
rows = []
for tf, dl, k1, b, cap, order in itertools.product(('one', 'stem'), ('distinct', 'tokens'), (0.6, 0.9, 1.2, 1.5, 2.0), (0.3, 0.5, 0.75, 0.9), (12, 16, 20, 40), ('first', 'long')):
    P = {**BASE, 'tf': tf, 'dl': dl, 'k1': k1, 'b': b, 'cap': cap, 'order': order}
    r = {f: evaluate(P, f, hybrid=False)[0]['bm25'] for f in ('question', 'keywords', 'bilingual')}
    rows.append((P, r))
json.dump(rows, open('grid.json', 'w'))
# selection on the tuning half only: question form first, then the mean of the three forms
key = lambda pr: (pr[1]['question']['tune'], sum(pr[1][f]['tune'] for f in pr[1]))
rows.sort(key=key, reverse=True)
for P, r in rows[:25]:
    print({k: P[k] for k in ('tf', 'dl', 'k1', 'b', 'cap', 'order')}, ' '.join(f"{f[:4]} {r[f]['tune']:.3f}/{r[f]['held']:.3f}/{r[f]['all']:.3f}" for f in r))
