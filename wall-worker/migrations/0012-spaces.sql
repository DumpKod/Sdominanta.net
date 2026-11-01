-- 18.10.2026: алеф-нули — дочерние пространства витрины. У каждой версии сцены своё пространство (space):
-- main — главная витрина, остальные открываются изнутри объекта с полем inner (адрес /in/{space}).
ALTER TABLE scenes ADD COLUMN space TEXT NOT NULL DEFAULT 'main';
CREATE INDEX scenes_space ON scenes (space, status, published_at);
