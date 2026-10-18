import { verifyTotp, STEP } from './totp';
import { Env, keepers } from './util';

// Подпись хранителя: TOTP, повтор кода отклоняется, 5 неверных подряд — блок на 15 минут.
// Ответ одинаков для «неверный код» и «нет такого хранителя»: строки блокировки ведутся для любого имени.

export const MAX_FAILS = 5;
export const LOCK_SEC = 15 * 60;

export type KeeperCheck = { ok: true } | { ok: false; locked: boolean };

export async function checkKeeper(env: Env, keeper: string, otp: string, now: number): Promise<KeeperCheck> {
  if (!keeper || [...keeper].length > 16) return { ok: false, locked: false };
  const db = env.DB;
  const lock = await db.prepare('SELECT fails, locked_until FROM keeper_lock WHERE keeper = ?').bind(keeper).first<{ fails: number; locked_until: number | null }>();
  if (lock?.locked_until && lock.locked_until > now) return { ok: false, locked: true };

  const step = await verifyTotp(keepers(env)[keeper], otp, now);
  if (step !== null) {
    await db.prepare('DELETE FROM otp_used WHERE step < ?').bind(Math.floor(now / STEP) - 10).run();
    // Вставка с первичным ключом атомарна: повтор того же кода (в том числе одновременный) не пройдёт.
    const ins = await db.prepare('INSERT OR IGNORE INTO otp_used (keeper, step) VALUES (?, ?)').bind(keeper, step).run();
    if (ins.meta.changes === 1) {
      await db.prepare('DELETE FROM keeper_lock WHERE keeper = ?').bind(keeper).run();
      return { ok: true };
    }
  }

  const row = await db
    .prepare(
      'INSERT INTO keeper_lock (keeper, fails, locked_until) VALUES (?, 1, NULL) ' +
        'ON CONFLICT (keeper) DO UPDATE SET fails = fails + 1 RETURNING fails',
    )
    .bind(keeper)
    .first<{ fails: number }>();
  if (row && row.fails >= MAX_FAILS) {
    await db.prepare('UPDATE keeper_lock SET fails = 0, locked_until = ? WHERE keeper = ?').bind(now + LOCK_SEC, keeper).run();
    return { ok: false, locked: true };
  }
  return { ok: false, locked: false };
}
