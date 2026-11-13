import sys, json
sys.argv = ['x', 'seed.json', 'cache.json', '../review-lists.json']
exec(open('tune.py').read().split("if __name__")[0])
CH = {**BASE, 'tf': 'stem', 'rule': 'tsq99', 'dl': 'distinct', 'k1': 1.2, 'b': 0.1}
FIX = {**BASE}
for name, P in (('#1326 intent, constants fixed (tf 1, b 0.75)', FIX), ('#1387 chosen', CH), ('#1387 stems for words of 6+ letters (not chosen)', {**CH, 'rule': 'tsq6'})):
    for f in ('question', 'keywords', 'bilingual'):
        r = evaluate(P, f)[0]
        print(name, f, json.dumps(r))
