"""Load the bench corpus (seed.json, #1242) into search_documents of the #1387 tuning database, in seed order (ids ascend as in the
live test, which writes them with search_put in the same order). Every message is visible to the asker (all six spaces)."""
import json, subprocess, sys, uuid
DB = 'flux-1387-tune-db-1'
seed = json.load(open(sys.argv[1]))
ws = str(uuid.uuid5(uuid.NAMESPACE_URL, 'flux-1387-ws'))
spaces = {s['key']: str(uuid.uuid5(uuid.NAMESPACE_URL, 'flux-1387-' + s['key'])) for s in seed['spaces']}
conv = {c['key']: c for c in seed['conversations']}
def q(s): return "'" + s.replace("'", "''") + "'"
out = ["BEGIN;", "SET session_replication_role = replica;",
       f"INSERT INTO workspaces (id, name, created_by) VALUES ({q(ws)}, 'Bench', 'bench') ON CONFLICT DO NOTHING;",
       "DELETE FROM search_documents;"]
for m in seed['messages']:
    c = conv[m['conversation']]
    sp = spaces[c['space']]
    out.append(f"INSERT INTO search_documents (doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, title, body, author_kind, author_id, at) VALUES ("
               f"{q('message:' + m['id'])}, 'message', {q(ws)}, {q('project:' + sp)}, {q(sp)}, {q(m['id'])}, {q(c['id'])}, '', {q(m['body'])}, 'human', {q(m['author'])}, {q(m['at'])});")
out.append("COMMIT;")
p = subprocess.run(['docker', 'exec', '-i', DB, 'psql', '-U', 'flux', '-d', 'flux', '-v', 'ON_ERROR_STOP=1', '-q'], input='\n'.join(out), text=True, capture_output=True)
print(p.stdout[-2000:], p.stderr[-2000:])
print(subprocess.run(['docker', 'exec', DB, 'psql', '-U', 'flux', '-d', 'flux', '-tAc', 'SELECT count(*) FROM search_documents'], capture_output=True, text=True).stdout)
