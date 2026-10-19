-- Аварийная копия слоя из редактора (решение хранителя 19.10): одна ячейка на пространство, перезаписывается
-- не чаще раза в минуту и только когда есть несохранённые правки; черновик или публикация слоя её стирают.
CREATE TABLE scene_recovery (space TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL, by_sign TEXT NOT NULL);
