"""Очищенный архив (tools/clean-archive.py) → SQL: документы в таблицу docs черновиком и ссылки files[].doc у узлов.
  python3 -I tools/archive-docs.py <очищенная папка> <дерево.json> > docs.sql
Файл дерева сопоставляется с архивом по имени: точное имя, иначе по коду даты (2026-10-14j_…) и словам названия.
"""
import json, os, re, sys, time

root, treef = sys.argv[1:3]
tree = json.load(open(treef))
files = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs if f != 'CLEANING.md')

def match(nm):
    nm = nm.split(' ')[0]
    for p in files:
        if p == nm or os.path.basename(p) == nm:
            return p
    key = nm.split('_')[0]
    c = [p for p in files if os.path.basename(p).split('_')[0] == key]
    if not c:
        return None
    w = set(re.split(r'[-_.+]', nm.lower()))
    return max(c, key=lambda p: len(w & set(re.split(r'[-_.+]', os.path.basename(p).lower()))))

def doc_name(p):
    b = os.path.basename(p)
    return b[:-3] if b.endswith('.md') else b

names = {}
for p in files:
    n = doc_name(p)
    assert re.match(r'^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$', n), n
    assert n not in names, ('повтор имени', n, p, names.get(n))
    names[n] = p

q = lambda s: "'" + s.replace("'", "''") + "'"
now = int(time.time())
out = []
for n, p in names.items():
    body = open(os.path.join(root, p), encoding='utf-8').read()
    m = re.search(r'^#\s+(.+)$', body, re.M)
    title = (m.group(1).strip() if m else n)[:200]
    out.append(f"INSERT OR REPLACE INTO docs (name, path, title, body, state, created_at) VALUES ({q(n)}, {q(p)}, {q(title)}, {q(body)}, 'черновик', {now});")
for node in tree['nodes']:
    fl = []
    for f in node.get('files', []):
        p = match(f['name'])
        x = {'name': f['name'], **({'drive': f['drive']} if f.get('drive') else {}), **({'url': f['url']} if f.get('url') else {})}
        if p:
            x['doc'] = doc_name(p)
        fl.append(x)
    if fl:
        out.append(f"UPDATE nodes SET files = {q(json.dumps(fl, ensure_ascii=False, separators=(',', ':')))} WHERE id = {q(node['id'])};")
print('\n'.join(out))
