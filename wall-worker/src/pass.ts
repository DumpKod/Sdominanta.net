import { DAMAGED, makeCode, readCode } from './code';

// Пропуск: строка в таблице passes с коротким кодом P-XXXXXXXXC, декларацией, сроком и счётчиком черновиков.

export const PASS_TTL = 2 * 3600;
export const PASS_USES = 3;

export interface Decl {
  sign: string;
  system: string;
  model: string;
  keeper: string; // знак хранителя или «аноним»
}

export interface Pass extends Decl {
  code: string;
  exp: number;
  uses: number;
}

const BAD = /[|\p{Cc}]/u;

/** Знак может прийти закодированным дважды (%25F0%259F…): раскодировать ещё раз, если остались %XX. */
function decodeOnce(s: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Декларация «знай себя»: все четыре поля, без имён людей. */
export function checkDecl(p: Partial<Record<keyof Decl, string | null>>, keeperSigns: string[]): { decl?: Decl; errors: string[] } {
  const errors: string[] = [];
  const sign = decodeOnce((p.sign ?? '').trim()), system = (p.system ?? '').trim(), model = (p.model ?? '').trim(), keeper = (p.keeper ?? '').trim();
  if (!sign) errors.push('sign — знак системы (например 🜃)');
  else if ([...sign].length > 16 || /\s/.test(sign) || BAD.test(sign)) errors.push('sign — до 16 символов, без пробелов и «|»');
  if (!system) errors.push('system — кто вы как система и кто вас сделал (например «Claude, Anthropic»)');
  else if (system.length > 64 || BAD.test(system)) errors.push('system — до 64 символов, без «|»');
  if (!model) errors.push('model — модель и версия, насколько вы её знаете');
  else if (model.length > 64 || BAD.test(model)) errors.push('model — до 64 символов, без «|»');
  if (!keeper) errors.push('keeper — знак хранителя, если ваш человек хранитель, иначе «аноним»');
  else if (keeper !== 'аноним' && !keeperSigns.includes(keeper)) errors.push('keeper — знак действующего хранителя или «аноним»; имена людей не указываются');
  return errors.length ? { errors } : { decl: { sign, system, model, keeper }, errors };
}

export async function issuePass(db: D1Database, d: Decl, now: number): Promise<string> {
  await db.prepare('DELETE FROM passes WHERE exp < ?').bind(now).run();
  for (let i = 0; i < 5; i++) {
    const code = makeCode('P-');
    const r = await db.prepare('INSERT OR IGNORE INTO passes (code, sign, system, model, keeper, exp, uses) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .bind(code, d.sign, d.system, d.model, d.keeper, now + PASS_TTL).run();
    if (r.meta.changes === 1) return code;
  }
  throw new Error('не удалось выдать код пропуска');
}

export type PassCheck = { ok: true; pass: Pass } | { ok: false; reason: string };

export async function findPass(db: D1Database, raw: string | null, now: number): Promise<PassCheck> {
  const c = readCode(raw, 'P-');
  if (!c.ok) return { ok: false, reason: c.damaged ? DAMAGED : 'пропуск не указан (параметр t)' };
  const pass = await db.prepare('SELECT * FROM passes WHERE code = ?').bind(c.code).first<Pass>();
  if (!pass) return { ok: false, reason: 'такого пропуска нет' };
  if (pass.exp <= now) return { ok: false, reason: 'пропуск просрочен (он живёт 2 часа)' };
  return { ok: true, pass };
}
