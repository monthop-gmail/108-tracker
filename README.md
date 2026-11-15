# 108 Tracker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/monthop-gmail/108-tracker)

แอปเดียวสำหรับบันทึกเรื่องร้อยแปดในชีวิต แต่ละเรื่องเป็น **โมดูล** ที่เปิด/ปิดได้ ใช้รหัสผ่านเดียว ติดตั้งเป็นแอปบนหน้าจอโฮมแค่ไอคอนเดียว
และเปิดการแจ้งเตือนครั้งเดียวก็ใช้ได้กับทุกโมดูล หน้า **วันนี้** รวมเรื่องที่ต้องทำจากทุกโมดูลไว้ในหน้าเดียว
รันบน **Cloudflare Workers + D1** (ใช้แพ็กเกจฟรีได้) และหน้าเว็บไม่ต้อง build

> A Thai-language, modular personal tracker for Cloudflare Workers + D1 — health log & medication reminders, bills,
> home/vehicle maintenance and pantry/shopping list in one PWA, with offline sync, a combined "today" view and one daily push digest.

| โมดูล | ทำอะไรได้ |
|---|---|
| 🩺 **สุขภาพ** | บันทึกกิจวัตรและอาการแบบแตะเดียว (บันทึกย้อนหลัง/แก้ไขได้) · ยากินและยาทาแยกตามมื้อ พร้อมเตือนตรงเวลาและปุ่ม "ใช้ยาแล้ว" บนการแจ้งเตือน · นัดหมอพร้อมเตือนล่วงหน้าและไฟล์ลงปฏิทิน · สรุปให้หมอดู (พิมพ์/PDF/CSV) |
| 💸 **ค่าใช้จ่าย** | รายการครั้งเดียว/รายเดือน/รายปี/ผ่อนเป็นงวด · เห็นว่างวดไหนจ่ายแล้วหรือยัง · บันทึกจ่ายย้อนหลัง · ประวัติรายเดือน ค้นหา และ CSV |
| 🔧 **ดูแลอุปกรณ์** | รอบดูแลตามเวลาหรือเลขไมล์ (นับจากครั้งที่ทำจริง) · งานแนะนำตามประเภทอุปกรณ์ · ประวัติซ่อมและค่าใช้จ่าย · เตือนก่อนประกันหมด |
| 🧺 **ของในบ้าน** | จำนวนของที่มี (กด − เมื่อใช้ / + เมื่อซื้อ) · ของที่เหลือถึงจุดสั่งซื้อจะขึ้นใน **รายการซื้อของ** เอง · ติ๊กของระหว่างอยู่ในห้างได้แม้ไม่มีเน็ต · แชร์รายการไป LINE · วันหมดอายุและเตือนก่อนหมด |

ไอเดียโมดูลถัดไป (expiry, expense, time, habit ฯลฯ) อยู่ใน [`docs/ideas.md`](docs/ideas.md)

## ใช้ร่วมกันทุกโมดูล

- **หน้า "วันนี้"**: ยาวันนี้ นัดถัดไป ค่าใช้จ่ายที่ค้างหรือใกล้ครบ งานดูแลที่เลยกำหนด ของที่ต้องซื้อและของใกล้หมดอายุ พร้อมปุ่มบันทึกด่วน
- **แจ้งเตือน (Web Push)**: เตือนยาตามมื้อและนัดหมอตามเวลา และส่ง **สรุปประจำวัน** ฉบับเดียวรวมทุกโมดูลตามเวลาที่ตั้งไว้
- **ใช้ได้ตอนเน็ตหลุด**: บันทึกลงเครื่องก่อน แล้วซิงก์ให้เองเมื่อกลับมาออนไลน์ (ซ้ำได้ ไม่เกิดรายการซ้อน)
- **ตั้งค่า**: เปิด/ปิดโมดูล หมวดของแต่ละโมดูล สำรอง/นำเข้าข้อมูลทั้งหมดเป็น JSON (รับไฟล์สำรองของแอปเดิมได้ด้วย) และ CSV แยกโมดูล
- PWA (มีปุ่มลัดบนไอคอน) · โหมดมืด · สีประจำแต่ละโมดูล · ฟอนต์ IBM Plex Sans Thai ในตัว

## วิธี deploy

### แบบที่ 1: ปุ่ม Deploy to Cloudflare (ง่ายที่สุด)

กดปุ่มด้านบน → ล็อกอิน Cloudflare + GitHub → ตั้งรหัสผ่าน `APP_PASSWORD` (อย่างน้อย 8 ตัว) → รอระบบสร้างฐานข้อมูลและ deploy

### แบบที่ 2: GitHub Actions (repo นี้หรือ fork)

ตั้ง secrets ใน repo (Settings → Secrets and variables → Actions) แล้ว push เข้า `main` หรือกด Run workflow

| Secret | | ค่า |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | จำเป็น | template **Edit Cloudflare Workers** + สิทธิ์ **Account → D1 → Edit** |
| `APP_PASSWORD` | แนะนำ | รหัสผ่านเข้าแอป (อย่างน้อย 8 ตัว) — workflow ตั้งให้ Worker เอง |
| `CLOUDFLARE_ACCOUNT_ID` | ไม่บังคับ | ใส่เมื่อ token เข้าถึงได้หลาย account |
| `API_TOKEN` | ไม่บังคับ | token สำหรับบันทึกผ่าน API / Shortcuts |

ไม่ต้องสร้างฐานข้อมูลเอง — `scripts/ensure-d1.mjs` จะหา/สร้างฐานข้อมูลชื่อ `108-tracker` ให้ตอน deploy

### แบบที่ 3: deploy เองด้วย Wrangler

```bash
npm ci && npx wrangler login
npx wrangler d1 create 108-tracker     # เอา database_id ไปใส่แทน 00000000-... ใน wrangler.jsonc
npx wrangler secret put APP_PASSWORD
npm run deploy
```

รันในเครื่อง: `cp .dev.vars.example .dev.vars` (ใส่ APP_PASSWORD) → `npm run db:migrate:local` → `npm run dev`

## ย้ายข้อมูลจากแอปเดิม

ถ้าเคยใช้ health-tracker, bill-tracker หรือ maintenance-tracker ในบัญชี Cloudflare เดียวกัน:

- **deploy ครั้งแรกจะย้ายข้อมูลให้เอง** (`scripts/import-legacy.mjs --once`) ทั้งบันทึก ยา นัด รายการค่าใช้จ่าย การจ่าย อุปกรณ์ งานดูแล บันทึก และค่าตั้ง (หมวด เวลามื้อยา เวลาเตือน)
- ช่วงที่ยังใช้แอปเดิมคู่กัน กด Run workflow **Import data from old apps** เพื่อซิงก์อีกครั้ง — รายการที่แก้ในแอปใหม่ภายหลังจะไม่ถูกทับ
- การแจ้งเตือนต้อง **เปิดใหม่** ในแอปนี้ (คนละเว็บกัน) และเพิ่มไอคอนบนหน้าจอโฮมใหม่
- อีกทางคือสำรองข้อมูล (JSON) จากแอปเดิม แล้วนำเข้าที่ **ตั้งค่า → ข้อมูล → นำเข้าข้อมูลสำรอง**

## ใช้บนมือถือ

- **iPhone**: Safari → แชร์ → "เพิ่มไปยังหน้าจอโฮม" · **Android**: Chrome → ⋮ → "ติดตั้งแอป"
- เปิดแจ้งเตือน: หน้า **วันนี้ → ⚙️ ตั้งค่า → การแจ้งเตือน** (iPhone ต้องเปิดจากไอคอนบนหน้าจอโฮม iOS 16.4+)
- กดค้างที่ไอคอนแอปเพื่อใช้ปุ่มลัด: บันทึกอาการ · บันทึกการจ่าย · บันทึกการดูแลอุปกรณ์ · เพิ่มของที่ต้องซื้อ

## บันทึกผ่าน API (iOS Shortcuts / สคริปต์)

ตั้ง token: `npx wrangler secret put API_TOKEN` (หรือ GitHub secret `API_TOKEN`) แล้วส่ง `Authorization: Bearer <API_TOKEN>`

```bash
H='-H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json"'
# สุขภาพ: บันทึกค่า (อ้างหมวดด้วยชื่อหรือ key)
curl -X POST https://<your-worker>/api/health/entries $H -d '{"category":"วัดค่า","text":"ความดัน 125/82"}'
# ค่าใช้จ่าย: จ่ายครั้งเดียว
curl -X POST https://<your-worker>/api/bills/payments $H -d '{"name":"ค่าซ่อมประตู","amount":450,"category":"บ้าน/ที่พัก"}'
# ดูแลอุปกรณ์: จดเลขไมล์ / บันทึกว่าทำงานดูแลแล้ว
curl -X POST https://<your-worker>/api/maint/logs $H -d '{"asset":"Honda City","meter":55210}'
curl -X POST https://<your-worker>/api/maint/logs $H -d '{"asset":"แอร์ห้องนอน","task":"ล้างแอร์","cost":600}'
# ของในบ้าน: ใช้ของไป / เพิ่มในรายการซื้อ
curl -X POST https://<your-worker>/api/pantry/use $H -d '{"name":"นม","qty":1}'
curl -X POST https://<your-worker>/api/pantry/shop $H -d '{"name":"ไข่ไก่","qty":10}'
```

## โครงสร้าง

```
src/index.ts                 Worker: login, /api/settings, /api/sync, router ของโมดูล, cron
src/core/                    auth · util · push (VAPID + aes128gcm) · notify (สรุปประจำวัน/เตือนตามเวลา) · module (สัญญาของโมดูล)
src/modules/<id>.ts          API + การเตือนของแต่ละโมดูล
public/core/                 โครงหน้าเว็บ: เมนู, หน้า "วันนี้", ตั้งค่า, outbox กลาง, ตัวแก้หมวด
public/modules/<id>/         หน้าเว็บของแต่ละโมดูล (+ ตรรกะที่ใช้ร่วมกับ Worker เช่น schedule.js)
migrations/                  0001_core · 0002_health · 0003_bills · 0004_maint · 0005_pantry (ตารางขึ้นต้นด้วยชื่อโมดูล)
scripts/ensure-d1.mjs        CI: หา/สร้างฐานข้อมูล D1
scripts/import-legacy.mjs    ย้ายข้อมูลจากแอปเดิม
docs/ideas.md                ไอเดียโมดูลถัดไป
```

### Cron

ใช้ Cron Trigger ตัวเดียว `* * * * *` (แพ็กเกจฟรีมีได้ 5 ตัวต่อบัญชี): ทุกนาทีเช็กการเตือนตามเวลา (ยา นัดหมอ) และต้นชั่วโมงเช็กสรุปประจำวัน — ทำงานเฉพาะเมื่อมีเครื่องเปิดรับการแจ้งเตือน

### API หลัก

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/login` · `/api/logout` · GET `/api/me` | เข้า/ออกจากระบบ, โมดูลที่เปิดใช้ |
| GET/PUT | `/api/settings` | เวลาสรุปประจำวัน, โมดูลที่เปิดใช้, โซนเวลา |
| POST | `/api/sync` | `{ops:[{mod, table?, type:'put', item} \| {mod, table?, type:'del', id, updated_at}]}` (idempotent, last-write-wins) |
| GET/POST | `/api/push/key` · `/subscribe` · `/unsubscribe` · `/test` · `/digest-now` | การแจ้งเตือน |
| | `/api/health/*` · `/api/bills/*` · `/api/maint/*` · `/api/pantry/*` | API ของแต่ละโมดูล (ดูหัวไฟล์ `src/modules/<id>.ts`) |

### เพิ่มโมดูลใหม่

1. `migrations/000N_<id>.sql` — ตารางขึ้นต้นด้วย `<id>_`
2. `src/modules/<id>.ts` — export `Module` (`route`, และถ้ามี `syncOp`, `digest`, `tick`) แล้วเพิ่มใน `MODULES` ของ `src/index.ts`
3. `public/modules/<id>/index.js` — export โมดูลหน้าเว็บ (`tabs`, `refresh`, `view(path)`, `today()`, `actions`, `sheet`, `settings()`, `exportData`, `importData`, `reset`) แล้วเพิ่มใน `ALL` ของ `public/core/app.js`
4. สีของโมดูลใน `public/styles.css` (`[data-mod="<id>"]`) และไฟล์ใน `SHELL` ของ `public/sw.js`

ปุ่มในหน้าเว็บใช้ `data-action="<id>:<ชื่อ>"` · ปุ่มในแผ่นล่างใช้ `data-x` · บันทึกที่ต้องใช้ตอนออฟไลน์ส่งผ่าน `ctx.queue(<id>, op)`

## ความปลอดภัยและข้อมูล

- ทุก API ต้องล็อกอิน (cookie HttpOnly ที่เซ็นด้วย HMAC) หรือ Bearer token; ผิดเกิน 10 ครั้งใน 15 นาทีล็อกชั่วคราว
- ไม่ยอมให้ใช้งานถ้า `APP_PASSWORD` ว่าง สั้นกว่า 8 ตัว หรือเป็นค่าตัวอย่าง · เปลี่ยนรหัสผ่าน = ทุกเครื่องหลุดล็อกอิน
- รหัสผ่านเดียวเปิดได้ทุกโมดูล (ทั้งข้อมูลสุขภาพและการเงิน) จึงควรตั้งรหัสผ่านที่เดายาก
- ฟอนต์และไฟล์ทั้งหมดเสิร์ฟจาก Worker เอง ไม่เรียกบริการภายนอก · CSP `default-src 'self'`
- D1 Time Travel กู้ฐานข้อมูลย้อนหลังได้ (ฟรี 7 วัน / Paid 30 วัน) และสำรองเป็น JSON ได้จากหน้าตั้งค่า

## สัญญาอนุญาต

โค้ดใช้สัญญาอนุญาต MIT (ดู `LICENSE`) · ฟอนต์ IBM Plex Sans Thai ใช้ SIL Open Font License 1.1
