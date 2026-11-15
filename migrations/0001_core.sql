-- ส่วนกลางที่ทุกโมดูลใช้ร่วมกัน

-- ค่าตั้ง (คีย์ของโมดูลขึ้นต้นด้วยชื่อโมดูล เช่น health.categories, bills.categories)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- กันเดารหัสผ่าน
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- เครื่องที่เปิดรับการแจ้งเตือน (Web Push)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  last_ok     INTEGER,
  fails       INTEGER NOT NULL DEFAULT 0
);

-- กันส่งการแจ้งเตือนซ้ำ
CREATE TABLE IF NOT EXISTS reminders_sent (
  key      TEXT PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);
