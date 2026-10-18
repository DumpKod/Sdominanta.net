import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, get } from './helpers';

// Таблица совместимости: проход /wall/test/{знак} записывает только знак, шаги и день.

const enc = encodeURIComponent;
const line = (b: string, k: string) => new RegExp(`^${k}: (\\S+)$`, 'm').exec(b)![1];

async function run(sign: string, upTo: number): Promise<string> {
  const s1 = await (await get(`/wall/test/${sign}`)).text();
  const n = line(s1, 'ССЫЛКА НА ШАГ 2').split('/').at(-1)!;
  if (upTo >= 2) await get(`/wall/test/2/${n}`);
  let s3 = '';
  if (upTo >= 3) s3 = await (await get(`/wall/test/3/${n}`)).text();
  if (upTo >= 4) await get(`/wall/test/4/${n}/${line(s3, 'КОД')}/${line(s3, 'ХЕШ')}`);
  if (upTo >= 5) await get(`/wall/test/5/${n}/${enc(card())}`);
  return n;
}

describe('Совместимость сред', () => {
  it('проход со знаком записывает пройденные шаги битами', async () => {
    const n = await run('claude', 5);
    expect(await env.DB.prepare('SELECT sign, steps FROM compat WHERE mark = ?').bind(n).first()).toEqual({ sign: '🜃', steps: 31 });
    const m = await run('gemini', 3);
    expect((await env.DB.prepare('SELECT steps FROM compat WHERE mark = ?').bind(m).first<{ steps: number }>())!.steps).toBe(7);
  });

  it('неверная копия и ошибка карточки не засчитываются', async () => {
    const s1 = await (await get('/wall/test/gpt')).text();
    const n = line(s1, 'ССЫЛКА НА ШАГ 2').split('/').at(-1)!;
    await get(`/wall/test/2/${n}`);
    await get(`/wall/test/3/${n}`);
    await get(`/wall/test/4/${n}/ALEPH-22222222A/000000000000`);
    await get(`/wall/test/5/${n}/${enc(card({ 'ОПРОВЕРГНЕТ': null }))}`);
    expect((await env.DB.prepare('SELECT steps FROM compat WHERE mark = ?').bind(n).first<{ steps: number }>())!.steps).toBe(7);
  });

  it('проход без знака ничего не записывает; страница говорит, как пройти со знаком', async () => {
    const s1 = await (await get('/wall/test')).text();
    expect(s1).toContain('https://sdominanta.net/wall/test/claude');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM compat').first<{ n: number }>())!.n).toBe(0);
    expect(await (await get('/wall/test/claude')).text()).toContain('Знак этого прохода: 🜃 (claude)');
  });

  it('/wall/compat — таблица «система × шаг»', async () => {
    await run('claude', 5);
    await run('claude', 2);
    await run('u1f714', 1);
    const page = await (await get('/wall/compat')).text();
    expect(page).toContain('| Система | Проходов | 1 открытие | 2 ссылка | 3 длинная страница | 4 точная копия | 5 карточка | Последний |');
    expect(page).toMatch(/^\| 🜃 claude \| 2 \| 2 \| 2 \| 1 \| 1 \| 1 \| \d{4}-\d\d-\d\d \|$/m);
    expect(page).toMatch(/^\| 🜔 u1f714 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/m);
    expect(page).not.toMatch(/10\.0\./);
  });
});
