import sys, itertools, json
sys.argv = ['x', 'seed.json', 'cache.json', '../review-lists.json']
exec(open('tune.py').read().split("if __name__")[0])
B = {**BASE, 'tf': 'stem', 'rule': 'bounded2', 'dl': 'tokens'}
for k1, b in itertools.product((0.9, 1.2, 1.5, 2.0), (0.0, 0.1, 0.2, 0.3)):
    P = {**B, 'k1': k1, 'b': b}
    r = {f: evaluate(P, f, hybrid=False)[0]['bm25'] for f in ('question', 'keywords', 'bilingual')}
    print('k1', k1, 'b', b, 'tune sum %.3f' % sum(r[f]['tune'] for f in r), ' '.join(f"{f[:4]} {r[f]['tune']:.3f}/{r[f]['held']:.3f}/{r[f]['all']:.3f}" for f in r), flush=True)
print('people plan: the word being typed as a prefix')
for part in (0.25, 0.5, 0.75, 1.0):
    P = {**B, 'k1': 1.2, 'b': 0.1, 'part': part}
    r = {f: evaluate(P, f, people=True, hybrid=False)[0]['bm25'] for f in ('question', 'keywords', 'bilingual')}
    print('part', part, 'tune sum %.3f' % sum(r[f]['tune'] for f in r), ' '.join(f"{f[:4]} {r[f]['tune']:.3f}/{r[f]['held']:.3f}/{r[f]['all']:.3f}" for f in r), flush=True)
