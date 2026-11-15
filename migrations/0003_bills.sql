-- โมดูลค่าใช้จ่าย: รายการที่ต้องจ่าย (ครั้งเดียว/รายสัปดาห์/รายเดือน/รายปี/ผ่อนเป็นงวด) และการจ่าย

CREATE TABLE IF NOT EXISTS bills_items (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                 -- เช่น ค่าไฟ, ประกันรถ
  category     TEXT NOT NULL DEFAULT 'other',
  amount       REAL,                          -- ยอดที่คาดไว้ (NULL = ไม่แน่นอน เช่น ค่าไฟ)
  unit         TEXT NOT NULL DEFAULT 'month', -- once / week / month / year
  every        INTEGER NOT NULL DEFAULT 1,    -- ทุก ๆ กี่ unit (เช่น 3 เดือน)
  start_due    TEXT NOT NULL,                 -- วันครบกำหนดงวดแรก YYYY-MM-DD
  end_date     TEXT,                          -- สิ้นสุด (ไม่บังคับ)
  count        INTEGER,                       -- จำนวนงวด (ผ่อน, ไม่บังคับ)
  remind_days  INTEGER NOT NULL DEFAULT 3,    -- เตือนก่อนครบกำหนดกี่วัน
  autopay      INTEGER NOT NULL DEFAULT 0,    -- หักบัญชีอัตโนมัติ
  method       TEXT NOT NULL DEFAULT '',      -- วิธีจ่ายปกติ
  details      TEXT NOT NULL DEFAULT '',      -- เลขผู้ใช้/เลขบัญชี/ช่องทางจ่าย
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bills_payments (
  id          TEXT PRIMARY KEY,               -- UUID สร้างจากฝั่งเครื่อง (รองรับบันทึกตอนออฟไลน์)
  bill_id     TEXT,                           -- NULL = จ่ายครั้งเดียวที่ไม่ได้ตั้งไว้
  period      TEXT,                           -- งวด (วันครบกำหนด) ที่การจ่ายนี้ปิด
  paid_date   TEXT NOT NULL,                  -- วันที่จ่ายจริง YYYY-MM-DD (บันทึกย้อนหลังได้)
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  amount      REAL,
  method      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'paid',   -- paid / skipped (ข้ามงวด)
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_payments_date ON bills_payments (deleted, paid_date);
CREATE INDEX IF NOT EXISTS idx_bills_payments_bill ON bills_payments (bill_id, period);
