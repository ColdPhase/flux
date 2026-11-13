"""Offline model of the #1387 ranked statement over the cache of collect.py: BM25 over the visible hits only (df, N, avgdl counted over
`cand`), a document's term frequency and length from its own tsvector. Tunes on a fixed half of the 60 questions, reports on the other
half and on all 60. The vector lists come from the #1341 review's live run (RECALL_LISTS), which do not depend on the BM25 order."""
import json, math, re, sys, unicodedata, itertools
from datetime import datetime, timezone

LET = {'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i'}
def fold(w):
    w = ''.join(c for c in unicodedata.normalize('NFD', w) if not unicodedata.category(c).startswith('M')).lower()
    return ''.join(LET.get(c, c) for c in w)
def stem(w):
    f = fold(w); n = len(f)
    return f[:-2] if n >= 6 else f[:-1] if n >= 4 else f
def plain(t): return re.sub(r'[^\w]+|_', ' ', t).strip()
def ts(s): return datetime.fromisoformat(s.replace('Z', '+00:00')) if 'T' in s or ' ' in s else datetime.fromisoformat(s + 'T00:00:00+00:00')

seed = json.load(open(sys.argv[1])); cache = json.load(open(sys.argv[2])); lists = json.load(open(sys.argv[3]))
Q = seed['questions']
# The fixed split: odd question numbers tune, even ones are held out (q01 tune, q02 held out, ...).
TUNE = {q['id'] for q in Q if int(q['id'][1:]) % 2 == 1}

TSV = re.compile(r"'((?:[^']|'')*)':([0-9A-D,]+)")
docs = {}
for i, o, at, n, tsv in cache['docs']:
    lex = []
    for m in TSV.finditer(tsv):
        word = m.group(1).replace("''", "'")
        pos = m.group(2).split(',')
        a = sum(1 for p in pos if p.endswith('A')); b = len(pos) - a
        lex.append((fold(word), a, b, word))
    tokens = sum(a + b for _, a, b, _r in lex)
    docs[i] = {'id': i, 'obj': o, 'at': ts(at.replace(' ', 'T').replace('+00', '+00:00')), 'distinct': n, 'tokens': tokens, 'lex': lex}
by_obj = {d['obj']: d for d in docs.values()}

def mset(kind, w, fields):
    m = cache['match'].get(f'{kind}:{w}', {})
    return set(itertools.chain.from_iterable(m.get(f, []) for f in fields))

def words_of(text, people):
    if people:
        ws = [w.lower() for w in re.findall(r'\w+', text)]
        typed = ws[-1] if ws and re.search(r'\w$', text) else None
    else:
        ws = plain(text).split(); typed = None
    seen = []
    for w in ws:
        if w not in seen: seen.append(w)
    return seen, typed

STOP = set()
def select(words, typed, P):
    cap = P['cap']
    if P.get('order') == 'long':
        keep = sorted(words, key=lambda w: (-len(w), words.index(w)))[:cap]
        sel = [w for w in words if w in keep]
    else:
        sel = words[:cap]
    if typed and typed in words and typed not in sel: sel[-1] = typed
    return sel

def rank(text, q, P, people=False):
    words, typed = words_of(text, people)
    sel = select(words, typed, P)
    since = ts(q['after']) if q.get('after') else None
    until = ts(q['before']) if q.get('before') else None
    body = {w: mset('W', w.lower(), ('body_pl', 'body_en')) for w in sel}
    title = {w: mset('W', w.lower(), ('title_pl', 'title_en')) for w in sel}
    part = set()
    pref = fold(typed) if typed else None
    if people and pref and len(pref) >= 2 and typed in sel:
        part = mset('P', pref, ('body_pl', 'body_en', 'title_pl', 'title_en'))
    ids = set().union(*body.values(), *title.values(), part) if sel else set()
    cand = [docs[i] for i in ids if (since is None or docs[i]['at'] >= since) and (until is None or docs[i]['at'] < until)]
    if not cand: return [], {}
    N = len(cand)
    dlkey = P['dl']
    avgdl = max(sum(d[dlkey] for d in cand) / N, 1)
    present = {w: {d['id'] for d in cand if d['id'] in body[w] or d['id'] in title[w]} for w in sel}
    idf = {w: math.log(1 + (N - len(present[w]) + 0.5) / (len(present[w]) + 0.5)) for w in sel}
    k1, b = P['k1'], P['b']
    stems = {w: stem(w) for w in sel}
    out = {}
    for d in cand:
        norm = 1 - b + b * d[dlkey] / avgdl
        held = [w for w in sel if d['id'] in present[w]]
        if P['tf'] == 'one':
            # #1326: tf 1, saturation applied to the sum
            whole = sum(idf[w] * (P['wt'] if d['id'] in title[w] else 1) for w in held)
            s = (whole if held else P['part'] * sum(idf.values()) / len(sel)) * (k1 + 1) / (1 + k1 * norm)
        else:
            s = 0.0
            for w in held:
                st = stems[w]
                ta = tb = 0
                if P['tf'] == 'stem':
                    fw = fold(w)
                    exact = len(fw) < 4
                    for lx, a, bb, raw in d['lex']:
                        rule = P.get('rule', 'prefix')
                        if rule.startswith('tsq'):
                            lw = w.lower(); L = int(rule[3:])
                            if len(lw) < L: ok = raw in (lw, fw)
                            else:
                                rs = lw[:-2] if len(lw) >= 6 else lw[:-1] if len(lw) >= 4 else lw
                                ok = raw.startswith(rs) or raw.startswith(st)
                        elif rule == 'exact': ok = lx == fw
                        elif exact: ok = lx == fw
                        elif rule == 'prefix': ok = lx.startswith(st)
                        else: ok = lx.startswith(st) and abs(len(lx) - len(fw)) <= int(rule[-1])
                        if ok: ta += a; tb += bb
                tin = d['id'] in title[w]; bin_ = d['id'] in body[w]
                if tin and ta == 0: ta = 1
                if bin_ and tb == 0: tb = 1
                if not tin: ta = 0
                if not bin_: tb = 0
                tf = P['wt'] * ta + tb
                s += idf[w] * tf * (k1 + 1) / (tf + k1 * norm)
            if not held:
                tf = 1
                s = P['part'] * (sum(idf.values()) / len(sel)) * tf * (k1 + 1) / (tf + k1 * norm)
        out[d['id']] = s
    order = sorted(out, key=lambda i: (-round(out[i] / (out[i] + 10), 6), -docs[i]['at'].timestamp(), -i))
    return order, out

def recall(ids, q):
    top = set(ids[:10]); return sum(g in top for g in q['gold_ids']) / len(q['gold_ids'])

def fuse(lex_ids, raw, vec_objs, depth=50):
    lexical = sorted(lex_ids, key=lambda i: (-raw[i], -docs[i]['at'].timestamp(), -i))[:depth]
    vec = [by_obj[o]['id'] for o in vec_objs[:depth]]
    sc = {}
    for lst in (lexical, vec):
        for r, i in enumerate(lst): sc[i] = sc.get(i, 0) + 1 / (60 + r + 1)
    return sorted(sc, key=lambda i: (-round(sc[i] * 30.5, 6), -docs[i]['at'].timestamp(), -i))

def evaluate(P, form='question', people=False, hybrid=True):
    res = {}
    for q in Q:
        text = q['keywords'] + ' ' + q['keywords_other'] if form == 'bilingual' else q[form]
        order, raw = rank(text, q, P, people)
        r = {'bm25': recall([docs[i]['obj'] for i in order], q)}
        if hybrid:
            vec = lists[f'{form}|{q["id"]}']['vec']
            r['hybrid'] = recall([docs[i]['obj'] for i in fuse(order, raw, vec)], q)
        res[q['id']] = r
    def agg(ids, key): return round(sum(res[i][key] for i in ids) / len(ids), 3)
    allq = [q['id'] for q in Q]; tune = [i for i in allq if i in TUNE]; held = [i for i in allq if i not in TUNE]
    keys = ['bm25'] + (['hybrid'] if hybrid else [])
    return {k: {'tune': agg(tune, k), 'held': agg(held, k), 'all': agg(allq, k)} for k in keys}, res

BASE = {'tf': 'one', 'k1': 1.2, 'b': 0.75, 'dl': 'distinct', 'wt': 2, 'part': 0.5, 'cap': 12, 'order': 'first'}
if __name__ == '__main__':
    for form in ('question', 'keywords', 'bilingual'):
        print('baseline', form, evaluate(BASE, form)[0])
