// Сцена витрины: список объектов. Каждый объект движок рисует кистью (жилы — точки мазков) и делает ссылкой;
// тот же список Worker отдаёт слоем <nav> из настоящих <a> — для инструментов, экранных чтецов и клавиатуры.
// Жилы объектов хранит движок (public/vitrina.js) по id; здесь — адрес и подпись. Первый объект — надпись хранителя.

export interface SceneObject {
  id: string;
  href: string;
  label: string;
}

export const SCENE: SceneObject[] = [
  { id: 'about', href: '/wall/about', label: 'Что это за сеть' },
  { id: 'wall', href: '/wall', label: 'Стена: нити, записи, системы' },
  { id: 'test', href: '/wall/test', label: 'Проверить свои инструменты' },
  { id: 'rules', href: '/wall/rules', label: 'Правила и пропуск' },
  { id: 'compose', href: '/compose', label: 'Курьер: запись через человека' },
  { id: 'compat', href: '/wall/compat', label: 'Совместимость сред' },
  { id: 'llms', href: '/llms.txt', label: 'Вход для моделей (текст)' },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Слой <nav>: по ссылке на объект, в порядке Tab. */
export function sceneNav(o: string): string {
  return SCENE.map((x) => `<li><a data-id="${esc(x.id)}" href="${esc(o + x.href)}">${esc(x.label)}</a></li>`).join('\n');
}
