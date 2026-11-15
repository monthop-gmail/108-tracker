-- โมดูลของในบ้าน: ของที่มี จำนวน จุดสั่งซื้อ วันหมดอายุ และรายการซื้อของ
-- ทั้งสองตารางแก้ได้ตอนออฟไลน์ (ซิงก์ผ่าน /api/sync แบบ last-write-wins)

CREATE TABLE IF NOT EXISTS pantry_items (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                 -- เช่น นมจืด, ไข่ไก่, ยาสีฟัน
  place        TEXT NOT NULL DEFAULT 'other', -- ที่เก็บ (key) เช่น fridge, freezer, pantry, bathroom
  qty          REAL NOT NULL DEFAULT 0,       -- จำนวนที่เหลือ
  unit         TEXT NOT NULL DEFAULT '',      -- ชิ้น ขวด ถุง กล่อง แพ็ก กก. ลิตร
  min_qty      REAL,                          -- จุดสั่งซื้อ: เหลือเท่านี้หรือน้อยกว่า = ต้องซื้อ (NULL = ไม่ติดตาม)
  buy_qty      REAL,                          -- ปกติซื้อครั้งละเท่าไร
  expires_on   TEXT,                          -- วันหมดอายุ (ของที่ใกล้หมดที่สุด)
  remind_days  INTEGER NOT NULL DEFAULT 3,    -- เตือนก่อนหมดอายุกี่วัน
  price        REAL,                          -- ราคาที่ซื้อล่าสุด (ต่อครั้งที่ซื้อ)
  shop         TEXT NOT NULL DEFAULT '',      -- ร้านที่ซื้อประจำ
  note         TEXT NOT NULL DEFAULT '',
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pantry_items_place ON pantry_items (deleted, place);

-- รายการซื้อของที่เพิ่มเอง (ของที่ต่ำกว่าจุดสั่งซื้อจะขึ้นในรายการให้อัตโนมัติ ไม่ต้องเก็บที่นี่)
CREATE TABLE IF NOT EXISTS pantry_shop (
  id          TEXT PRIMARY KEY,
  item_id     TEXT,                           -- ผูกกับของในบ้าน (ถ้ามี) — ซื้อแล้วจะเพิ่มจำนวนให้
  name        TEXT NOT NULL,
  qty         REAL,
  unit        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  done_at     INTEGER,                        -- ซื้อแล้วเมื่อไร (NULL = ยังไม่ซื้อ)
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pantry_shop_open ON pantry_shop (deleted, done_at);
