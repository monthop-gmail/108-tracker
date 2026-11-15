-- โมดูลสุขภาพ: บันทึกกิจวัตร/อาการ ยา นัดหมอ

CREATE TABLE IF NOT EXISTS health_entries (
  id          TEXT PRIMARY KEY,          -- UUID สร้างจากฝั่งเครื่อง (รองรับบันทึกตอนออฟไลน์)
  ts          INTEGER NOT NULL,          -- เวลาที่เหตุการณ์เกิดขึ้น (epoch ms) — บันทึกย้อนหลังได้
  category    TEXT NOT NULL,             -- key ของหมวด เช่น med, food, symptom
  text        TEXT NOT NULL DEFAULT '',  -- รายละเอียด
  level       INTEGER,                   -- ระดับ 1–5 (สำหรับหมวดที่มีระดับ เช่น อาการ อารมณ์)
  meta        TEXT,                      -- ข้อมูลประกอบ (JSON) เช่น บันทึกทานยาชุดไหน วันไหน
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_entries_ts  ON health_entries (deleted, ts);
CREATE INDEX IF NOT EXISTS idx_health_entries_cat ON health_entries (category, ts);

CREATE TABLE IF NOT EXISTS health_meds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                 -- ชื่อยา
  dose          TEXT NOT NULL DEFAULT '',      -- ขนาดต่อครั้ง เช่น 1 เม็ด, 5 ml, ทาบาง ๆ
  method        TEXT NOT NULL DEFAULT 'กิน',   -- กิน / ทา / หยอด / พ่น-สูด / ฉีด / อื่น ๆ
  instructions  TEXT NOT NULL DEFAULT '',      -- หลังอาหาร, ก่อนอาหาร 30 นาที ...
  purpose       TEXT NOT NULL DEFAULT '',      -- ใช้สำหรับ
  notes         TEXT NOT NULL DEFAULT '',      -- หมายเหตุ ผลข้างเคียงที่ต้องสังเกต
  slots         TEXT NOT NULL DEFAULT '{}',    -- {"morning":"", "evening":"½ เม็ด"} มื้อที่ใช้ + ขนาดเฉพาะมื้อ
  start_date    TEXT,                          -- YYYY-MM-DD (ไม่บังคับ)
  end_date      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_appts (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,                  -- วันเวลานัด (epoch ms)
  title       TEXT NOT NULL,                     -- เช่น ตรวจติดตามความดัน
  place       TEXT NOT NULL DEFAULT '',          -- โรงพยาบาล / คลินิก / ห้องตรวจ
  doctor      TEXT NOT NULL DEFAULT '',          -- แพทย์ / แผนก
  details     TEXT NOT NULL DEFAULT '',          -- รายละเอียด การเตรียมตัว
  remind      TEXT NOT NULL DEFAULT '[1440,180]',-- เตือนล่วงหน้า (นาที)
  status      TEXT NOT NULL DEFAULT 'scheduled', -- scheduled / done / cancelled
  result      TEXT NOT NULL DEFAULT '',          -- ผลการตรวจ / คำแนะนำหมอ
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_appts_ts ON health_appts (status, ts);
