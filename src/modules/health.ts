/**
 * โมดูลสุขภาพ: บันทึกกิจวัตร/อาการ ยาตามมื้อ นัดหมอ และการเตือน
 *
 *   GET    /api/health/entries?from=&to=&limit=     → รายการในช่วงเวลา (epoch ms)
 *   POST   /api/health/entries   {category, text?, level?, ts?}  → สร้างรายการเดียว (Shortcuts/สคริปต์)
 *   GET    /api/health/suggestions                 → ข้อความที่ใช้บ่อยของแต่ละหมวด
 *   GET/PUT /api/health/categories, POST /api/health/categories/reset
 *   GET    /api/health/care                         → {meds, slots, appointments}
 *   PUT    /api/health/meds/:id  {med} · DELETE /api/health/meds/:id
 *   PUT    /api/health/med-slots {slots}
 *   POST   /api/health/meds/take {slot, date?, ts?, note?, taken?}  → บันทึกว่าใช้ยาชุดนี้แล้ว (ใช้จากปุ่มบนการแจ้งเตือน)
 *   PUT    /api/health/appointments/:id {appointment} · DELETE · GET /api/health/appointments/:id/ics
 *   sync: {mod:'health', type:'put', item: entry} | {mod:'health', type:'del', id, updated_at}
 */
import { Env, json, readJson, ID_RE, MIN_TS, DAY, clip, clientTs, getSetting, putSetting, localParts, getTz } from '../core/util';
import { Module, Category, Note, categoryRoutes, getCategories, isCatKey, pathId } from '../core/module';

type Entry = { id: string; ts: number; category: string; text: string; level: number | null; meta: string | null; updated_at: number };
export type Slot = { key: string; label: string; time: string; remind: boolean };
export type Med = {
  id: string;
  name: string;
  dose: string;
  method: string;
  instructions: string;
  purpose: string;
  notes: string;
  slots: Record<string, string>; // key มื้อ → ขนาดเฉพาะมื้อ ('' = ใช้ขนาดปกติ)
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  sort: number;
  created_at?: number;
  updated_at: number;
};
export type Appt = {
  id: string;
  ts: number;
  title: string;
  place: string;
  doctor: string;
  details: string;
  remind: number[]; // นาทีก่อนนัด
  status: 'scheduled' | 'done' | 'cancelled';
  result: string;
  updated_at: number;
};

export const DEFAULT_CATEGORIES: Category[] = [
  { key: 'med', label: 'ยา', emoji: '💊', presets: ['ยาเช้า', 'ยากลางวัน', 'ยาเย็น', 'ยาก่อนนอน'] },
  { key: 'food', label: 'อาหาร', emoji: '🍚', presets: ['มื้อเช้า', 'มื้อกลางวัน', 'มื้อเย็น', 'ของว่าง'] },
  { key: 'water', label: 'ดื่มน้ำ', emoji: '💧', presets: ['1 แก้ว', '2 แก้ว', '1 ขวด'] },
  { key: 'symptom', label: 'อาการ', emoji: '🤒', scale: true, presets: ['ปวดหัว', 'เวียนหัว', 'คลื่นไส้', 'เหนื่อยง่าย', 'ปวดท้อง', 'ไอ'] },
  { key: 'vitals', label: 'วัดค่า', emoji: '🩺', presets: ['ความดัน ', 'ชีพจร ', 'น้ำตาล ', 'น้ำหนัก ', 'อุณหภูมิ '] },
  { key: 'bowel', label: 'ขับถ่าย', emoji: '🚽', presets: ['ปกติ', 'ท้องผูก', 'ท้องเสีย', 'ปัสสาวะ'] },
  { key: 'sleep', label: 'เข้านอน', emoji: '😴', presets: [] },
  { key: 'wake', label: 'ตื่นนอน', emoji: '🌅', presets: ['หลับดี', 'หลับไม่สนิท', 'ตื่นกลางดึก'] },
  { key: 'exercise', label: 'ออกกำลัง', emoji: '🚶', presets: ['เดิน 30 นาที', 'ยืดเหยียด'] },
  { key: 'mood', label: 'อารมณ์', emoji: '🙂', scale: true, presets: ['สดชื่น', 'ปกติ', 'เครียด', 'กังวล', 'อ่อนเพลีย'] },
  { key: 'note', label: 'จดไว้', emoji: '📝', presets: [] },
];
const CAT_SETTING = 'health.categories';
const SLOT_SETTING = 'health.med_slots';

export const DEFAULT_SLOTS: Slot[] = [
  { key: 'morning', label: 'เช้า', time: '08:00', remind: true },
  { key: 'noon', label: 'กลางวัน', time: '12:00', remind: true },
  { key: 'evening', label: 'เย็น', time: '18:00', remind: true },
  { key: 'bedtime', label: 'ก่อนนอน', time: '21:00', remind: true },
];
const SLOT_KEY_RE = /^[a-z0-9_]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = new Set(['scheduled', 'done', 'cancelled']);

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const dayNum = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY;

// ---------- บันทึก ----------
function validateEntry(e: any, now: number): Entry | string {
  if (!e || typeof e !== 'object') return 'bad_entry';
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return 'bad_id';
  const ts = Number(e.ts);
  if (!Number.isFinite(ts) || ts < MIN_TS || ts > now + 2 * DAY) return 'bad_ts';
  if (!isCatKey(e.category)) return 'bad_category';
  const text = e.text == null ? '' : String(e.text).trim();
  if (text.length > 4000) return 'text_too_long';
  const level = e.level == null || e.level === '' ? null : Number(e.level);
  if (level !== null && (!Number.isInteger(level) || level < 1 || level > 5)) return 'bad_level';
  let meta: string | null = null;
  if (e.meta != null) {
    if (typeof e.meta !== 'object' || Array.isArray(e.meta)) return 'bad_meta';
    meta = JSON.stringify(e.meta);
    if (meta.length > 2000) return 'meta_too_long';
  }
  return { id: e.id, ts: Math.round(ts), category: e.category, text, level, meta, updated_at: clientTs(e.updated_at, now) };
}

function upsertEntry(env: Env, e: Entry, now: number): D1PreparedStatement {
  // last-write-wins ตาม updated_at — ข้อมูลที่ค้างส่งตอนออฟไลน์จะไม่ทับของที่ใหม่กว่า
  return env.DB.prepare(
    `INSERT INTO health_entries (id, ts, category, text, level, meta, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?8, 0, ?7, ?6)
     ON CONFLICT(id) DO UPDATE SET
       ts = excluded.ts, category = excluded.category, text = excluded.text,
       level = excluded.level, meta = excluded.meta, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= health_entries.updated_at`
  ).bind(e.id, e.ts, e.category, e.text, e.level, e.updated_at, now, e.meta);
}

const getCats = (env: Env) => getCategories(env, CAT_SETTING, DEFAULT_CATEGORIES, true);

// ---------- ยา ----------
function rowMed(r: any): Med {
  let slots: Record<string, string> = {};
  try {
    slots = JSON.parse(r.slots || '{}');
  } catch {}
  return {
    id: r.id,
    name: r.name,
    dose: r.dose,
    method: r.method,
    instructions: r.instructions,
    purpose: r.purpose,
    notes: r.notes,
    slots,
    start_date: r.start_date ?? null,
    end_date: r.end_date ?? null,
    active: !!r.active,
    sort: r.sort ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function validateMed(id: string, m: any): Med | string {
  if (!m || typeof m !== 'object') return 'bad_med';
  const name = clip(m.name, 100);
  if (!name) return 'med_name_required';
  const slots: Record<string, string> = {};
  if (m.slots && typeof m.slots === 'object' && !Array.isArray(m.slots)) {
    for (const [k, v] of Object.entries(m.slots).slice(0, 10)) {
      if (!SLOT_KEY_RE.test(k)) return 'bad_slot_key';
      slots[k] = clip(v, 60);
    }
  }
  const date = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
  return {
    id,
    name,
    dose: clip(m.dose, 60),
    method: clip(m.method, 20) || 'กิน',
    instructions: clip(m.instructions, 200),
    purpose: clip(m.purpose, 100),
    notes: clip(m.notes, 1000),
    slots,
    start_date: date(m.start_date),
    end_date: date(m.end_date),
    active: m.active !== false,
    sort: Number.isFinite(Number(m.sort)) ? Math.round(Number(m.sort)) : 0,
    updated_at: Date.now(),
  };
}

async function listMeds(env: Env): Promise<Med[]> {
  const { results } = await env.DB.prepare('SELECT * FROM health_meds ORDER BY active DESC, sort, name').all();
  return results.map(rowMed);
}

function isDue(m: Med, slot: string, date: string): boolean {
  return m.active && slot in m.slots && (!m.start_date || m.start_date <= date) && (!m.end_date || date <= m.end_date);
}

/** ข้อความยาหนึ่งตัวในมื้อ เช่น "Amlodipine 5 mg 1 เม็ด (หลังอาหาร)" */
function medText(m: Med, slot: string, withInstr: boolean): string {
  const dose = (m.slots[slot] || m.dose || '').trim();
  const base = [m.name, dose].filter(Boolean).join(' ');
  return withInstr && m.instructions ? `${base} (${m.instructions})` : base;
}

function validateSlots(input: any): Slot[] | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) return 'bad_slots';
  const seen = new Set<string>();
  const out: Slot[] = [];
  for (const s of input) {
    const key = String(s?.key ?? '');
    if (!SLOT_KEY_RE.test(key) || seen.has(key)) return 'bad_slot_key';
    seen.add(key);
    const label = clip(s.label, 20);
    if (!label) return 'bad_slot_label';
    const time = String(s.time ?? '');
    if (!TIME_RE.test(time)) return 'bad_slot_time';
    out.push({ key, label, time, remind: s.remind !== false });
  }
  return out;
}

const getSlots = (env: Env) => getSetting<Slot[]>(env, SLOT_SETTING, DEFAULT_SLOTS);

async function takenAlready(env: Env, slot: string, date: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM health_entries WHERE deleted = 0 AND meta IS NOT NULL AND ts > ?1
       AND json_extract(meta, '$.slot') = ?2 AND json_extract(meta, '$.date') = ?3 LIMIT 1`
  )
    .bind(now - 10 * DAY, slot, date)
    .first();
  return !!row;
}

// ---------- นัดหมอ ----------
function rowAppt(r: any): Appt {
  let remind: number[] = [];
  try {
    remind = JSON.parse(r.remind || '[]');
  } catch {}
  return { id: r.id, ts: r.ts, title: r.title, place: r.place, doctor: r.doctor, details: r.details, remind, status: r.status, result: r.result, updated_at: r.updated_at };
}

function validateAppt(id: string, a: any, now: number): Appt | string {
  if (!a || typeof a !== 'object') return 'bad_appointment';
  const ts = Number(a.ts);
  if (!Number.isFinite(ts) || ts < MIN_TS || ts > now + 5 * 365 * DAY) return 'bad_ts';
  const title = clip(a.title, 120);
  if (!title) return 'title_required';
  const remind = Array.isArray(a.remind)
    ? [...new Set(a.remind.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 20160))].slice(0, 6)
    : [1440, 180];
  const status = STATUSES.has(a.status) ? a.status : 'scheduled';
  return {
    id,
    ts: Math.round(ts),
    title,
    place: clip(a.place, 120),
    doctor: clip(a.doctor, 120),
    details: clip(a.details, 4000),
    remind: remind as number[],
    status,
    result: clip(a.result, 4000),
    updated_at: now,
  };
}

async function listAppts(env: Env): Promise<Appt[]> {
  const { results } = await env.DB.prepare('SELECT * FROM health_appts ORDER BY ts DESC LIMIT 500').all();
  return results.map(rowAppt);
}

// ไฟล์ปฏิทิน (.ics) สำหรับเพิ่มนัดลงแอปปฏิทินในมือถือ พร้อมการเตือนของปฏิทินเอง
function apptIcs(a: Appt, now: number): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line: string) => {
    // RFC 5545: บรรทัดละไม่เกิน 75 ไบต์ โดยไม่ตัดกลางตัวอักษร UTF-8
    let out = '';
    let cur = '';
    let len = 0;
    let limit = 75;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (len + n > limit) {
        out += cur + '\r\n ';
        cur = '';
        len = 0;
        limit = 74;
      }
      cur += ch;
      len += n;
    }
    return out + cur;
  };
  const desc = [a.doctor && `แพทย์/แผนก: ${a.doctor}`, a.details].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//108-tracker//TH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // UID เดิมจากแอป health-tracker — นัดที่ย้ายมาจะไม่ซ้ำในปฏิทินถ้าเคยเพิ่มไว้แล้ว
    `UID:${a.id}@daily-health-log`,
    `DTSTAMP:${dt(now)}`,
    `DTSTART:${dt(a.ts)}`,
    `DTEND:${dt(a.ts + 3600000)}`,
    `SUMMARY:${esc(`นัดหมอ: ${a.title}`)}`,
    ...(a.place ? [`LOCATION:${esc(a.place)}`] : []),
    ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
    ...a.remind.flatMap((min) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(a.title)}`, `TRIGGER:-PT${min}M`, 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- routes ----------
async function route(req: Request, env: Env, url: URL, now: number, sub: string): Promise<Response | null> {
  const method = req.method;

  if (sub === '/entries' && method === 'GET') {
    const from = Number(url.searchParams.get('from') ?? 0) || 0;
    const to = Number(url.searchParams.get('to') ?? 0) || now + 2 * DAY;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 5000) || 5000, 1), 50000);
    const { results } = await env.DB.prepare(
      `SELECT id, ts, category, text, level, meta, updated_at FROM health_entries
       WHERE deleted = 0 AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`
    )
      .bind(from, to, limit)
      .all<Entry>();
    const entries = results.map((e) => {
      let meta: unknown = null;
      if (e.meta) {
        try {
          meta = JSON.parse(e.meta);
        } catch {}
      }
      return { ...e, meta };
    });
    return json({ entries });
  }

  if (sub === '/entries' && method === 'POST') {
    // สร้างรายการเดียวแบบง่าย — ใช้กับ iOS Shortcuts / curl
    const body = await readJson(req);
    const cats = await getCats(env);
    const raw = String(body?.category ?? '').trim();
    const cat = cats.find((c) => c.key === raw || c.label === raw);
    if (!cat) return json({ error: 'unknown_category', categories: cats.map((c) => c.label) }, 400);
    const v = validateEntry({ id: crypto.randomUUID(), ts: body.ts ?? now, category: cat.key, text: body.text, level: body.level, meta: null, updated_at: now }, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertEntry(env, v, now).run();
    return json({ ok: true, entry: v }, 201);
  }

  if (sub === '/suggestions' && method === 'GET') {
    const since = now - 120 * DAY;
    const { results } = await env.DB.prepare(
      `SELECT category, text FROM (
         SELECT category, text, MAX(ts) AS last,
                ROW_NUMBER() OVER (PARTITION BY category ORDER BY COUNT(*) DESC, MAX(ts) DESC) AS rn
         FROM health_entries
         WHERE deleted = 0 AND text <> '' AND ts > ? AND length(text) <= 60
         GROUP BY category, text
       ) WHERE rn <= 8 ORDER BY category, rn`
    )
      .bind(since)
      .all<{ category: string; text: string }>();
    const out: Record<string, string[]> = {};
    for (const r of results) (out[r.category] ||= []).push(r.text);
    return json({ suggestions: out });
  }

  if (sub === '/care' && method === 'GET') {
    const [meds, appointments, slots] = await Promise.all([listMeds(env), listAppts(env), getSlots(env)]);
    return json({ meds, appointments, slots });
  }

  let id = pathId(sub, 'meds');
  if (id && method === 'PUT') {
    const body = await readJson(req);
    const v = validateMed(id, body?.med);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO health_meds (id, name, dose, method, instructions, purpose, notes, slots, start_date, end_date, active, sort, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, dose = excluded.dose, method = excluded.method,
         instructions = excluded.instructions, purpose = excluded.purpose, notes = excluded.notes, slots = excluded.slots,
         start_date = excluded.start_date, end_date = excluded.end_date, active = excluded.active, sort = excluded.sort,
         updated_at = excluded.updated_at`
    )
      .bind(v.id, v.name, v.dose, v.method, v.instructions, v.purpose, v.notes, JSON.stringify(v.slots), v.start_date, v.end_date, v.active ? 1 : 0, v.sort, now)
      .run();
    const saved = await env.DB.prepare('SELECT * FROM health_meds WHERE id = ?').bind(v.id).first();
    return json({ ok: true, med: rowMed(saved) });
  }
  if (id && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM health_meds WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (sub === '/med-slots' && method === 'PUT') {
    const body = await readJson(req);
    const v = validateSlots(body?.slots);
    if (typeof v === 'string') return json({ error: v }, 400);
    await putSetting(env, SLOT_SETTING, v);
    return json({ ok: true, slots: v });
  }

  if (sub === '/meds/take' && method === 'POST') {
    const body = await readJson(req);
    const [slots, tz, meds] = await Promise.all([getSlots(env), getTz(env), listMeds(env)]);
    const slot = slots.find((s) => s.key === body?.slot);
    if (!slot) return json({ error: 'unknown_slot' }, 400);
    const date = typeof body?.date === 'string' && DATE_RE.test(body.date) ? body.date : localParts(now, tz).date;
    if (await takenAlready(env, slot.key, date, now)) return json({ ok: true, already: true });
    const due = meds.filter((x) => isDue(x, slot.key, date));
    const taken = Array.isArray(body?.taken) ? due.filter((x) => body.taken.includes(x.id)) : due;
    const skipped = due.filter((x) => !taken.includes(x));
    const note = clip(body?.note, 500);
    let text = `ยา${slot.label}: ${taken.map((x) => medText(x, slot.key, false)).join(', ') || '—'}`;
    if (skipped.length) text += ` · ไม่ได้ใช้: ${skipped.map((x) => x.name).join(', ')}`;
    if (note) text += `\n${note}`;
    const ts = Number.isFinite(Number(body?.ts)) && Number(body.ts) > MIN_TS && Number(body.ts) < now + DAY ? Math.round(Number(body.ts)) : now;
    const entry = {
      id: crypto.randomUUID(),
      ts,
      category: 'med',
      text,
      level: null,
      meta: { slot: slot.key, date, taken: taken.map((x) => x.id), skipped: skipped.map((x) => x.id) },
      updated_at: now,
    };
    await env.DB.prepare(
      `INSERT INTO health_entries (id, ts, category, text, level, meta, deleted, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6, ?6)`
    )
      .bind(entry.id, entry.ts, entry.category, entry.text, JSON.stringify(entry.meta), now)
      .run();
    return json({ ok: true, entry }, 201);
  }

  const ics = sub.match(/^\/appointments\/([A-Za-z0-9_-]{8,64})\/ics$/);
  if (ics && method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM health_appts WHERE id = ?').bind(ics[1]).first();
    if (!row) return json({ error: 'not_found' }, 404);
    return new Response(apptIcs(rowAppt(row), now), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'attachment; filename="appointment.ics"',
        'cache-control': 'no-store',
      },
    });
  }

  id = pathId(sub, 'appointments');
  if (id && method === 'PUT') {
    const body = await readJson(req);
    const v = validateAppt(id, body?.appointment, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO health_appts (id, ts, title, place, doctor, details, remind, status, result, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, title = excluded.title, place = excluded.place, doctor = excluded.doctor,
         details = excluded.details, remind = excluded.remind, status = excluded.status, result = excluded.result,
         updated_at = excluded.updated_at`
    )
      .bind(v.id, v.ts, v.title, v.place, v.doctor, v.details, JSON.stringify(v.remind), v.status, v.result, now)
      .run();
    return json({ ok: true, appointment: v });
  }
  if (id && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM health_appts WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return categoryRoutes(req, env, sub, CAT_SETTING, DEFAULT_CATEGORIES, true);
}

function syncOp(env: Env, op: any, now: number): D1PreparedStatement | string {
  if (op?.type === 'put') {
    const v = validateEntry(op.item, now);
    return typeof v === 'string' ? v : upsertEntry(env, v, now);
  }
  if (op?.type === 'del') {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return 'bad_id';
    return env.DB.prepare('UPDATE health_entries SET deleted = 1, updated_at = ?2 WHERE id = ?1 AND updated_at <= ?2').bind(op.id, clientTs(op.updated_at, now));
  }
  return 'bad_op';
}

// ---------- เตือนตามเวลา (cron ทุกนาที) ----------
function whenText(ts: number, now: number, tz: string): string {
  const a = localParts(ts, tz);
  const b = localParts(now, tz);
  const days = dayNum(a.date) - dayNum(b.date);
  const time = `${String(Math.floor(a.minutes / 60)).padStart(2, '0')}:${String(a.minutes % 60).padStart(2, '0')}`;
  const dateText = new Intl.DateTimeFormat('th-TH', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ts);
  if (days <= 0) return `วันนี้ ${time}`;
  if (days === 1) return `พรุ่งนี้ ${time}`;
  return `อีก ${days} วัน (${dateText} ${time})`;
}

async function tick(env: Env, now: number, tz: string): Promise<Note[]> {
  const [slots, allMeds] = await Promise.all([getSlots(env), listMeds(env)]);
  const { date, minutes } = localParts(now, tz);
  const notes: Note[] = [];

  // ยาแต่ละมื้อ: เตือนตอนถึงเวลา และย้ำอีกครั้งหลัง 60 นาทีถ้ายังไม่บันทึก
  for (const s of slots) {
    if (!s.remind) continue;
    const diff = minutes - toMin(s.time);
    if (diff < 0 || diff >= 90) continue;
    const due = allMeds.filter((x) => isDue(x, s.key, date));
    if (!due.length) continue;
    if (await takenAlready(env, s.key, date, now)) continue;
    const stage = diff >= 60 ? 1 : 0;
    notes.push({
      key: `med:${date}:${s.key}:${stage}`,
      payload: {
        type: 'med',
        slot: s.key,
        date,
        tag: `med-${date}-${s.key}`,
        title: stage ? `ยังไม่ได้บันทึกยา${s.label}` : `ถึงเวลายา${s.label} (${s.time})`,
        body: due.map((x) => '• ' + medText(x, s.key, true)).join('\n').slice(0, 1500),
        url: `/?take=${s.key}&date=${date}`,
      },
    });
  }

  // นัดหมอ: เตือนตามเวลาที่ตั้งไว้ล่วงหน้า
  const { results } = await env.DB.prepare("SELECT * FROM health_appts WHERE status = 'scheduled' AND ts > ?1 AND ts < ?2")
    .bind(now, now + 15 * DAY)
    .all();
  for (const a of results.map(rowAppt)) {
    for (const off of a.remind) {
      const fireAt = a.ts - off * 60000;
      if (now < fireAt || now - fireAt > 6 * 3600000) continue;
      const lines = [a.title, [a.place, a.doctor].filter(Boolean).join(' · ')];
      if (a.details) lines.push(a.details.split('\n')[0]);
      notes.push({
        key: `appt:${a.id}:${a.ts}:${off}`,
        payload: {
          type: 'appt',
          id: a.id,
          tag: `appt-${a.id}`,
          title: `นัดหมอ${whenText(a.ts, now, tz)}`,
          body: lines.filter(Boolean).join('\n').slice(0, 1500),
          url: '/#/health/appts',
        },
      });
    }
  }
  return notes;
}

export const health: Module = {
  id: 'health',
  label: 'สุขภาพ',
  emoji: '🩺',
  route,
  syncOp,
  tick,
};
