-- 18.10.2026: очередь IndexNow — изменённые публичные адреса ждут пачки (не чаще раза в минуту).
CREATE TABLE indexnow_queue (url TEXT PRIMARY KEY, at INTEGER NOT NULL);
