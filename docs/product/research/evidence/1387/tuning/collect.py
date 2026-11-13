"""Ask the tuning database's BM25 index (migration 0065) which documents hold each query word (Polish or English stem, accents folded),
which hold each typed prefix, and read every document's own tsvector. Output: cache.json for tune.py."""
import json, re, subprocess, sys, unicodedata
DB = 'flux-1387-tune-db-1'
seed = json.load(open(sys.argv[1]))
LET = {'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i'}
def fold(w):
    w = ''.join(c for c in unicodedata.normalize('NFD', w) if not unicodedata.category(c).startswith('M')).lower()
    return ''.join(LET.get(c, c) for c in w)
def plain(t): return re.sub(r'[^\w]+|_', ' ', t).strip()
def q(s): return "'" + s.replace("'", "''") + "'"
def psql(sql):
    p = subprocess.run(['docker', 'exec', '-i', DB, 'psql', '-U', 'flux', '-d', 'flux', '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t'], input=sql, text=True, capture_output=True)
    if p.returncode: sys.exit(p.stderr)
    return p.stdout
texts = set()
for x in seed['questions']:
    texts |= {x['question'], x['keywords'], x['keywords'] + ' ' + x['keywords_other']}
words, prefixes = set(), set()
for t in texts:
    ws = plain(t).split()
    words |= {w.lower() for w in ws}
    if ws: prefixes.add(fold(ws[-1].lower()))
words = sorted(words); prefixes = sorted(p for p in prefixes if len(p) >= 2)
sql = []
for w in words:
    for f in ('body_pl', 'body_en', 'title_pl', 'title_en'):
        col = 'body' if f.startswith('body') else 'title'
        sql.append(f"SELECT 'W', {q(w)}, {q(f)}, id FROM search_documents sd WHERE sd.{col}::pdb.alias('{f}') ||| {q(w)}::text;")
for p in prefixes:
    for f in ('body_pl', 'body_en', 'title_pl', 'title_en'):
        col = 'body' if f.startswith('body') else 'title'
        sql.append(f"SELECT 'P', {q(p)}, {q(f)}, id FROM search_documents sd WHERE sd.{col}::pdb.alias('{f}') @@@ pdb.regex({q(p + '.*')}::text);")
match = {}
for line in psql('\n'.join(sql)).splitlines():
    k, w, f, i = line.split('\t')
    match.setdefault(k + ':' + w, {}).setdefault(f, []).append(int(i))
docs = []
for line in psql("SELECT id, object_id, at, length(tsv), tsv::text FROM search_documents ORDER BY id;").splitlines():
    i, o, at, n, tsv = line.split('\t')
    docs.append([int(i), o, at, int(n), tsv])
json.dump({'match': match, 'docs': docs, 'words': words, 'prefixes': prefixes}, open(sys.argv[2], 'w'))
print(len(words), 'words', len(prefixes), 'prefixes', len(docs), 'docs', len(match), 'match keys')
