// После деплоя открытая витрина переходит на новую версию сама (решение хранителя 19.10).
// Страница знает свой номер выкладки (data-build), /build — номер на сайте. Сверка — при возвращении на вкладку
// и раз в 2 минуты. Разошлись:
// - гость, музыка не играет — обновление, как только вкладка скрыта или полминуты нет движений (не рвём чтение и жест);
// - играет музыка или открыт редактор хранителя — плашка «Вышла новая версия» с кнопкой: звук и несохранённые правки
//   не обрываются без спроса.

const root = document.documentElement;
const mine = root.dataset.build;
if (mine && mine !== 'dev') {
  const keeper = root.dataset.keeper === '1';
  let stale = false, act = performance.now(), note = null;
  const playing = () => !!document.querySelector('.music-play[aria-pressed="true"]');
  const quiet = () => document.visibilityState === 'hidden' || performance.now() - act > 30000;

  function notice() {
    if (note) return;
    note = document.createElement('div');
    note.className = 'fresh';
    note.setAttribute('role', 'status');
    note.textContent = keeper ? 'Вышла новая версия сайта. Сохраните правки и обновите страницу. ' : 'Вышла новая версия сайта. ';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Обновить';
    b.addEventListener('click', () => location.reload());
    note.append(b);
    document.body.append(note);
  }

  function maybe() {
    if (!stale) return;
    if (keeper || playing()) return notice();
    if (quiet()) location.reload();
  }

  const check = () => {
    if (stale) return maybe();
    fetch('/build', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => { const v = t && t.trim(); if (v && /^[0-9a-z-]{3,64}$/.test(v) && v !== mine) { stale = true; maybe(); } })
      .catch(() => {});
  };

  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, () => { act = performance.now(); }, { passive: true });
  document.addEventListener('visibilitychange', check);
  setInterval(check, 120000);
  setInterval(maybe, 5000);
}
