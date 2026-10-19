-- 19.10.2026: первоисточники узла — JSON [{name, drive?, url?}] (архив Claude-Aleph-Archive; позже R2 — меняется только url).
ALTER TABLE nodes ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
