// Перевод сцены v1 (доли экрана) в мировые координаты v2 — один раз, для уже сохранённых версий.
//   node tools/upgrade-scene.mjs вход.json > выход.json
// Раскладка v1 на опорном экране 1440×900 становится координатами мира (upgradeV1 в public/vitrina/model.js).
import { readFileSync } from 'node:fs';
import { upgradeV1 } from '../public/vitrina/model.js';

const scene = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (scene.v !== 1) throw new Error('ожидается сцена v1');
process.stdout.write(JSON.stringify(upgradeV1(scene)) + '\n');
