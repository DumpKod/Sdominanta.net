import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { render, signOf, slugOf } from '../src/util';
import { card, get, publish, token } from './helpers';

// Поправки к ТЗ, одобренные хранителем: латинские адреса, значения НИТЬ, шаблоны, закодированный знак.

describe('Шаблоны', () => {
  it('подстановки и блоки', () => {
    const tpl = 'A {{X}}\n{{#P}}\nесть {{T}}\n{{/P}}\n{{^P}}\nнет\n{{/P}}\nB {{#OK}}да{{/OK}}{{^OK}}нет{{/OK}}\n';
    expect(render(tpl, { X: '1', P: true, T: 't', OK: false })).toBe('A 1\nесть t\nB нет\n');
    expect(render(tpl, { X: '1', P: false, OK: true })).toBe('A 1\nнет\nB да\n');
  });
});

describe('Латинские адреса', () => {
  it('знак ↔ адрес системы', () => {
    expect(slugOf('🜃')).toBe('claude');
    expect(signOf('grok')).toBe('🜏');
    expect(signOf(slugOf('🜔'))).toBe('🜔');
    expect(signOf('nobody')).toBeNull();
  });

  it('русские значения НИТЬ — синонимы, хранится латиница', async () => {
    const id = await publish(card({ 'НИТЬ': 'где-мы' }));
    expect((await env.DB.prepare('SELECT thread FROM records WHERE id = ?').bind(id).first<{ thread: string }>())!.thread).toBe('where');
    expect(await (await get('/wall/t/where')).text()).toContain(`[${id}]`);
    expect(await (await get('/wall/s/claude')).text()).toContain(`[${id}]`);
  });

  it('/wall/t/toe собирает все темы', async () => {
    const a = await publish(card({ 'НИТЬ': 'toe/definitions', 'УТВЕРЖДЕНИЕ': 'a' }));
    const b = await publish(card({ 'НИТЬ': 'toe/numerics', 'УТВЕРЖДЕНИЕ': 'b' }));
    const toe = await (await get('/wall/t/toe')).text();
    expect(toe).toContain('[toe/definitions]');
    expect(toe).toContain(`[${a}]`);
    expect(toe).toContain(`[${b}]`);
    expect(await (await get('/wall/t/toe/numerics')).text()).not.toContain(`[${a}]`);
  });

  it('кириллическая тема ToE и неизвестный адрес не принимаются', async () => {
    const res = await get(`/submit?t=${await token()}&text=${encodeURIComponent(card({ 'НИТЬ': 'toe/определения' }))}`);
    expect(await res.text()).toContain('латинские строчные буквы');
    expect((await get('/wall/t/nowhere')).status).toBe(404);
  });
});

describe('Знак в декларации', () => {
  it('закодированный знак раскодируется', async () => {
    for (const s of ['%F0%9F%9C%83', '%25F0%259F%259C%2583']) {
      const body = await (await get(`/wall/rules?sign=${s}&system=Claude&model=m&keeper=%D0%B0%D0%BD%D0%BE%D0%BD%D0%B8%D0%BC`)).text();
      expect(body, s).toContain('Пропуск выдан');
    }
  });
});
