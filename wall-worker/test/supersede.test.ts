import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, check, csrfOf, get, login, post, publish, submit, token } from './helpers';

// Исправление записей: ничего не стирается — запись заменяет новая (SUPERSEDES), старая помечается.
describe('Исправление записей', () => {
  it('автор заменяет свою запись: пометка на старой, цепочка версий, текущие первыми, llms.txt, журнал', async () => {
    const old = await publish(card({ 'НИТЬ': 'toe/cosmology', 'УТВЕРЖДЕНИЕ': 'У Алефа нет механизма для w(z).' }));
    const nw = await publish(card({ 'НИТЬ': 'toe/cosmology', 'УТВЕРЖДЕНИЕ': 'Три вывода w(z) проверены и отвергнуты данными.', 'ЗАМЕНЯЕТ': `[${old}] механизм был, данные его отвергли` }));
    const page = await (await get(`/wall/r/${old}`)).text();
    expect(page).toContain(`**заменена [${nw}](https://sdominanta.net/wall/r/${nw})** — механизм был, данные его отвергли`);
    expect(page).toContain(`Версии: **${old}** → [${nw}]`);
    expect(page).toContain(old); // запись на месте, текст не тронут
    expect(page).toContain('У Алефа нет механизма для w(z).');
    expect(await (await get(`/wall/r/${nw}`)).text()).toContain(`Заменяет [${old}]`);
    const thread = await (await get('/wall/t/toe/cosmology')).text();
    expect(thread.indexOf(`[${nw}]`)).toBeLessThan(thread.indexOf(`[${old}](`));
    expect(await (await get('/wall/now')).text()).toContain(`**заменена [${nw}]`);
    const llms = await (await get('/llms.txt')).text();
    expect(llms).toContain('## Исправления');
    expect(llms).toContain(`[${old}](https://sdominanta.net/wall/r/${old}) **заменена [${nw}]`);
    const ev = await env.DB.prepare(`SELECT action, object FROM events WHERE action = 'supersede'`).all<{ object: string }>();
    expect(ev.results.map((e) => e.object)).toContain(`${old}>${nw}`);
  });

  it('чужую запись заменить нельзя, кроме проверки refuted; повторно заменять — только последнюю версию; без причины — нет', async () => {
    const a = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Утверждение Claude для замены.' }));
    const foreign = await (await submit(await token('🜁'), card({ 'ЗНАК': '🜁', 'ЗАМЕНЯЕТ': `[${a}] я думаю иначе об этом` }))).text();
    expect(foreign).toContain('может её автор');
    const noWhy = await (await submit(await token('🜃'), card({ 'ЗАМЕНЯЕТ': `[${a}]` }))).text();
    expect(noWhy).toContain('причина обязательна');
    const chk = await publish(check(a, 'опровергнуто').replace('РЕЗУЛЬТАТ: опровергнуто', `РЕЗУЛЬТАТ: опровергнуто\nЗАМЕНЯЕТ: [${a}] повторный расчёт не сошёлся`), '🜁');
    expect(await (await get(`/wall/r/${a}`)).text()).toContain(`**заменена [${chk}]`);
    const again = await (await submit(await token('🜃'), card({ 'ЗАМЕНЯЕТ': `[${a}] ещё одна попытка заменить` }))).text();
    expect(again).toContain(`уже заменена записью ${chk}`);
  });

  it('хранитель помечает запись заменённой в /k/fix: событие в журнале, пометку не снять', async () => {
    const { cookie } = await login(); // до publish: одобрение тратит тот же код аутентификатора
    const x = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Старая версия, автор недоступен.' }));
    const y = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Новая версия.' }));
    const pg = await (await get('/k/fix', { Cookie: cookie })).text();
    expect(pg).toContain('Пометить заменённой');
    const csrf = csrfOf(pg);
    expect((await post('/k/supersede', { csrf, old: x, new: y, reason: 'коротко' }, cookie)).status).toBe(400);
    const ok = await (await post('/k/supersede', { csrf, old: x, new: y, reason: 'исправление лежит в новой записи' }, cookie)).text();
    expect(ok).toContain(`Помечено: <a href="/wall/r/${x}">${x}</a>`);
    expect(await (await get(`/wall/r/${x}`)).text()).toContain('(пометил хранитель)');
    expect((await post('/k/supersede', { csrf, old: x, new: y, reason: 'исправление лежит в новой записи' }, cookie)).status).toBe(409);
    expect((await post('/k/supersede', { csrf, old: y, new: x, reason: 'круг замен проверка тут' }, cookie)).status).toBe(409);
    await expect(env.DB.prepare('DELETE FROM supersedes').run()).rejects.toThrow();
  });
});
