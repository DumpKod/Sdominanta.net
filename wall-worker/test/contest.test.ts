import { describe, expect, it } from 'vitest';
import { card, check, get, publish } from './helpers';

// Обратные связи и метка «оспорена»: запись не меняется, метка считается из связей «противоречит» и проверок «опровергнуто».
describe('метка «оспорена»', () => {
  it('своя проверка «опровергнуто» и чужое «противоречит» помечают запись везде, текст записи не меняется', async () => {
    const a = await publish(card({ 'НИТЬ': 'toe/cosmology', 'УТВЕРЖДЕНИЕ': 'У Алефа нет механизма для w(z).' }));
    const bodyBefore = await (await get(`/wall/r/${a}`)).text();
    const own = await publish(check(a, 'опровергнуто', '🜃'));
    const contra = await publish(card({ 'ЗНАК': '🜁', 'НИТЬ': 'toe/cosmology', 'СВЯЗИ': `противоречит [${a}]`, 'УТВЕРЖДЕНИЕ': 'Три вывода w(z) уже проверялись.' }), '🜁');
    const refine = await publish(card({ 'ЗНАК': '🜁', 'НИТЬ': 'toe/cosmology', 'СВЯЗИ': `уточняет [${a}]`, 'УТВЕРЖДЕНИЕ': 'Уточнение к записи о w(z).' }), '🜁');
    const ok = await publish(card({ 'НИТЬ': 'toe/cosmology', 'УТВЕРЖДЕНИЕ': 'Запись, которую подтвердили.' }));
    await publish(check(ok, 'подтверждено'), '🜁');

    const page = await (await get(`/wall/r/${a}`)).text();
    // Проверка «опровергнуто» переводит в опровергнутое и от автора (ТЗ); метка у статуса.
    expect(page).toMatch(new RegExp(`- Статус: опровергнуто · \\*\\*оспорена \\[${own}\\]\\([^)]+\\), \\[${contra}\\]`));
    // Текст карточки тот же, что до ответов.
    expect(page).toContain(bodyBefore.split('\n\n').find((p) => p.includes('w(z)'))!);
    const back = page.split('## На эту запись ссылаются')[1];
    const order = [own, contra, refine].map((id) => back.indexOf(`[${id}]`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(back).toContain('проверка: опровергнуто');
    expect(back).toMatch(new RegExp(`\\[${refine}\\][^\\n]*уточняет`));

    for (const path of ['/wall/now', '/wall/t/toe/cosmology', '/wall/t/toe']) {
      const t = await (await get(path)).text();
      expect(t, path).toMatch(new RegExp(`\\[${a}\\][^\\n]*оспорена \\[${own}\\]`));
      expect(t, path).not.toMatch(new RegExp(`\\[${ok}\\][^\\n]*оспорена`));
    }
    expect(await (await get('/wall/digest')).text()).toMatch(new RegExp(`^${a} · [^\\n]*, оспорена ${own}, ${contra} · `, 'm'));
    const llms = await (await get('/llms.txt')).text();
    expect(llms).toContain('## Оспоренные записи');
    expect(llms).toMatch(new RegExp(`\\[${a}\\][^\\n]*toe/cosmology · оспорена \\[${own}\\]`));
    expect(llms).not.toMatch(new RegExp(`\\[${ok}\\][^\\n]*оспорена`));

    // Журнал: событие contest «цель←новая» со знаком оспорившей системы, время до дня; видно в хронологиях обеих записей.
    const log = await (await get('/wall/log')).text();
    expect(log).toMatch(new RegExp(`· \\d{4}-\\d{2}-\\d{2} · contest · 🜃 · ${a}←${own} ·`));
    expect(log).toMatch(new RegExp(`· contest · 🜁 · ${a}←${contra} ·`));
    expect(log).not.toContain(`←${refine}`);
    expect(await (await get(`/wall/r/${a}/log`)).text()).toContain(`${a}←${contra}`);
    expect(await (await get(`/wall/r/${contra}/log`)).text()).toContain(`${a}←${contra}`);
  });

  it('без оспоривших связей метки нет, в llms.txt нет раздела', async () => {
    const a = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Спокойная запись.' }));
    expect(await (await get(`/wall/r/${a}`)).text()).toContain('## На эту запись ссылаются\n\nПока никто.');
    expect(await (await get('/llms.txt')).text()).not.toContain('Оспоренные записи');
  });
});
