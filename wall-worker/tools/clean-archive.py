"""Чистка архива перед публикацией: убрать время по Киеву (часы:минуты), пометки о местонахождении и занятости хранителя.
Остаётся только теория; даты — до дня (правило хранителя: его время публично — с точностью до суток).
  python3 -I tools/clean-archive.py <папка архива> <куда> <карта.json>
Карта — {"map": {путь в архиве: [id узлов]}}; чистятся только файлы из неё. Отчёт об изменениях — <куда>/CLEANING.md.
Личное, что правило не узнаёт, — в EXACT (точные замены) и в списке «проверить глазами» отчёта.
"""
import json, os, re, sys

src, dst, mapf = sys.argv[1:4]
files = sorted(json.load(open(mapf))['map'])

# точные замены: занятость и местонахождение хранителя
EXACT = [
    ('Работа без 🜄 (14 окт, 03:01: у него боевое дежурство, «делай, я пассивен»).', 'Работа без 🜄.'),
    ('🜄 на дежурстве (30 мин полёт / 30 «отдых»), разрешил', '🜄 разрешил'),
    ('Напоминание 🜄 (дома):', 'Напоминание 🜄:'),
    ('— вечер дома: ', '— '),
    ('🜄 дома, опыт с колонками отложен (поздно).', 'Опыт с колонками отложен.'),
    ('(ЖДЁТ: дома)', '(ЖДЁТ)'),
    ('ждёт 🜄 дома', 'ждёт 🜄'),
    ('ждёт 🜄 после ротации, дома', 'ждёт 🜄'),
]
T = r'~?[0-2]?\d:[0-5]\d'
RULES = [
    # «(00:12–01:47 Киев)», «04:27→04:31 (Киев)», «16 окт 23:10 – 17 окт 00:05 (Киев)»
    (re.compile(rf'\s*\(?(\d{{1,2}} окт\s+)?{T}(\s*[–—→-]\s*(\d{{1,2}} окт\s+)?{T})?\s*\(?Киев\)?\)?'), ''),
    # «(14 окт, 00:09)» → «(14 окт)»; «(02:57–03:06)» → убрать
    (re.compile(rf',\s*{T}(\s*[–—→-]\s*{T})?(?=\s*[):])'), ''),
    (re.compile(rf'\s*\({T}(\s*[–—→-]\s*{T})?\)'), ''),
    (re.compile(rf'\(({T})(\s*[–—→-]\s*{T})?:\s*'), '('),
    (re.compile(rf'(\d{{1,2}} окт(?:ября)?|окт 2026),?\s+{T}'), r'\1'),
    (re.compile(r'\s*\(Киев\)'), ''),
    # «… (поиск + счёт), 15:34–15:42» в конце строки
    (re.compile(rf',\s*{T}\s*[–—→-]\s*{T}\s*$', re.M), ''),
]
SUSPECT = re.compile(r'(дежур|боев|полёт|дома\b|поздно|пассивен|ротаци|FPV|Киев|[0-2]?\d:[0-5]\d)', re.I)

report = ['# Чистка архива: что изменено', '', 'Правила: время суток и «Киев» убраны, даты — до дня; занятость и местонахождение хранителя — убраны.', '']
look = []
for p in files:
    text = open(os.path.join(src, p), encoding='utf-8').read()
    out = text
    for a, b in EXACT:
        out = out.replace(a, b)
    for r, b in RULES:
        out = r.sub(b, out)
    # пустые скобки и «,.» после вырезанного — только в изменённых строках (иначе ломается код: .tobytes())
    ol, nl = text.split('\n'), out.split('\n')
    assert len(ol) == len(nl), p
    out = '\n'.join(y if x == y else re.sub(r',\s*\.', '.', re.sub(r'\s*\(\s*\)', '', y)) for x, y in zip(ol, nl))
    os.makedirs(os.path.dirname(os.path.join(dst, p)), exist_ok=True)
    open(os.path.join(dst, p), 'w', encoding='utf-8').write(out)
    a, b = text.split('\n'), out.split('\n')
    ch = [(i + 1, x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y]
    if ch:
        report.append(f'## {p} — строк изменено: {len(ch)}')
        for i, x, y in ch[:40]:
            report += [f'- {i}: `{x.strip()[:160]}`', f'  → `{y.strip()[:160]}`']
        report.append('')
    for i, y in enumerate(b):
        m = SUSPECT.search(y)
        if m and not re.match(r'^\s*(\||[-*]?\s*[\w.-]+\s*@)', y):
            look.append(f'- {p}:{i + 1}: `{y.strip()[:180]}`')
report += ['## Проверить глазами (остались слова-маркеры)', ''] + (look or ['Ничего.'])
open(os.path.join(dst, 'CLEANING.md'), 'w', encoding='utf-8').write('\n'.join(report) + '\n')
print('files', len(files), 'suspects', len(look))
