import sys, itertools, json
sys.argv = ['x', 'seed.json', 'cache.json', '../review-lists.json']
exec(open('tune.py').read().split("if __name__")[0])
for rule, b in itertools.product(('tsq4', 'tsq5', 'tsq6', 'tsq7', 'tsq99', 'bounded2'), (0.0, 0.1, 0.2, 0.3, 0.75)):
    P = {**BASE, 'tf': 'stem', 'rule': rule, 'dl': 'distinct', 'k1': 1.2, 'b': b}
    r = {f: evaluate(P, f)[0] for f in ('question', 'keywords', 'bilingual')}
    print(rule, 'b', b, 'tune %.3f' % sum(r[f]['bm25']['tune'] for f in r), ' '.join(f"{f[:4]} {r[f]['bm25']['tune']:.3f}/{r[f]['bm25']['held']:.3f}/{r[f]['bm25']['all']:.3f} h {r[f]['hybrid']['held']:.3f}/{r[f]['hybrid']['all']:.3f}" for f in r), flush=True)
