/**
 * โมดูลดูแลอุปกรณ์: อุปกรณ์ (assets) งานดูแลตามรอบ (tasks) และบันทึก (logs)
 *
 *   GET    /api/maint/data            → {assets, tasks, logs, categories}
 *   POST   /api/maint/logs            {asset, task?, kind?, date?, meter?, cost?, provider?, note?}  → บันทึกผ่าน Shortcuts/สคริปต์
 *   PUT    /api/maint/assets/:id      {asset}
 *   DELETE /api/maint/assets/:id      (ลบงานของอุปกรณ์นี้ด้วย และซ่อนบันทึก)
 *   PUT    /api/maint/tasks/:id       {task}
 *   DELETE /api/maint/tasks/:id       (บันทึกเดิมยังอยู่)
 *   GET/PUT /api/maint/categories, POST /api/maint/categories/reset
 *   sync: {mod:'maint', type:'put', item: log} | {mod:'maint', type:'del', id, updated_at}
 */
import { Env, json, readJson, ID_RE, clip, isDate, optDate, num, clientTs, localParts, getTz } from '../core/util';
import { Module, Category, DigestItem, categoryRoutes, getCategories, isCatKey, pathId } from '../core/module';
import { taskStatus, warrantyLeft } from '../../public/modules/maint/schedule.js';

export type Asset = {
  id: string;
  name: string;
  category: string;
  location: string;
  brand: string;
  model: string;
  serial: string;
  purchase_date: string | null;
  price: number | null;
  warranty_until: string | null;
  warranty_remind_days: number;
  contact: string;
  notes: string;
  meter_unit: string;
  meter_start: number | null;
  meter_start_date: string | null;
  active: boolean;
  created_at?: number;
  updated_at: number;
};
export type Task = {
  id: string;
  asset_id: string;
  name: string;
  unit: string;
  every: number | null;
  every_meter: number | null;
  first_due: string | null;
  first_due_meter: number | null;
  remind_days: number;
  remind_meter: number | null;
  est_cost: number | null;
  notes: string;
  active: boolean;
  updated_at: number;
};
export type Log = {
  id: string;
  asset_id: string;
  task_id: string | null;
  kind: 'done' | 'repair' | 'reading' | 'note';
  done_date: string;
  title: string;
  meter: number | null;
  cost: number | null;
  provider: string;
  note: string;
  updated_at: number;
};

export const DEFAULT_CATEGORIES: Category[] = [
  { key: 'car', label: 'รถยนต์', emoji: '🚗' },
  { key: 'motorcycle', label: 'มอเตอร์ไซค์', emoji: '🛵' },
  { key: 'aircon', label: 'แอร์', emoji: '❄️' },
  { key: 'appliance', label: 'เครื่องใช้ไฟฟ้า', emoji: '🧺' },
  { key: 'water', label: 'น้ำ/ปั๊ม/กรองน้ำ', emoji: '💧' },
  { key: 'electronics', label: 'คอมพิวเตอร์/ไอที', emoji: '💻' },
  { key: 'safety', label: 'ความปลอดภัย', emoji: '🧯' },
  { key: 'home', label: 'บ้าน/โครงสร้าง', emoji: '🏠' },
  { key: 'garden', label: 'สวน/เครื่องมือ', emoji: '🌳' },
  { key: 'other', label: 'อื่น ๆ', emoji: '📦' },
];
const CAT_SETTING = 'maint.categories';

const UNITS = new Set(['day', 'week', 'month', 'year', 'once', '']);
const KINDS = new Set(['done', 'repair', 'reading', 'note']);

// ---------- แปลงแถว ----------
const rowAsset = (r: any): Asset => ({ ...r, active: !!r.active });
const rowTask = (r: any): Task => ({ ...r, active: !!r.active });
const rowLog = (r: any): Log => {
  const { deleted, created_at, ...rest } = r;
  return rest;
};

// ---------- ตรวจข้อมูล ----------
function validateAsset(id: string, a: any, now: number): Asset | string {
  if (!a || typeof a !== 'object') return 'bad_asset';
  const name = clip(a.name, 120);
  if (!name) return 'name_required';
  const purchase = optDate(a.purchase_date);
  const warranty = optDate(a.warranty_until);
  const startDate = optDate(a.meter_start_date);
  if (purchase === 'bad' || warranty === 'bad' || startDate === 'bad') return 'bad_date';
  const price = num(a.price);
  const meterStart = num(a.meter_start, 1e9);
  if (price === 'bad' || meterStart === 'bad') return 'bad_number';
  const wr = Number(a.warranty_remind_days ?? 30);
  return {
    id,
    name,
    category: isCatKey(a.category) ? a.category : 'other',
    location: clip(a.location, 80),
    brand: clip(a.brand, 80),
    model: clip(a.model, 80),
    serial: clip(a.serial, 80),
    purchase_date: purchase,
    price,
    warranty_until: warranty,
    warranty_remind_days: Number.isInteger(wr) && wr >= 0 && wr <= 365 ? wr : 30,
    contact: clip(a.contact, 300),
    notes: clip(a.notes, 2000),
    meter_unit: clip(a.meter_unit, 10),
    meter_start: meterStart,
    meter_start_date: meterStart != null ? startDate ?? new Date(now).toISOString().slice(0, 10) : null,
    active: a.active !== false,
    updated_at: now,
  };
}

function validateTask(id: string, t: any, now: number): Task | string {
  if (!t || typeof t !== 'object') return 'bad_task';
  if (typeof t.asset_id !== 'string' || !ID_RE.test(t.asset_id)) return 'bad_asset_id';
  const name = clip(t.name, 120);
  if (!name) return 'name_required';
  const unit = String(t.unit ?? '');
  if (!UNITS.has(unit)) return 'bad_unit';
  const every = t.every == null || t.every === '' ? null : Number(t.every);
  if (every !== null && (!Number.isInteger(every) || every < 1 || every > 1000)) return 'bad_every';
  const everyMeter = num(t.every_meter, 1e7);
  const firstDue = optDate(t.first_due);
  const firstDueMeter = num(t.first_due_meter, 1e9);
  const remindMeter = num(t.remind_meter, 1e7);
  const estCost = num(t.est_cost);
  if (everyMeter === 'bad' || firstDueMeter === 'bad' || remindMeter === 'bad' || estCost === 'bad') return 'bad_number';
  if (firstDue === 'bad') return 'bad_first_due';
  const timed = ['day', 'week', 'month', 'year'].includes(unit);
  if (timed && !every) return 'every_required';
  if (unit === 'once' && !firstDue) return 'first_due_required';
  if (!timed && unit !== 'once' && !everyMeter) return 'schedule_required';
  const remind = Number(t.remind_days ?? 7);
  return {
    id,
    asset_id: t.asset_id,
    name,
    unit,
    every: timed ? every : null,
    every_meter: unit === 'once' ? null : everyMeter,
    first_due: firstDue,
    first_due_meter: unit === 'once' ? null : firstDueMeter,
    remind_days: Number.isInteger(remind) && remind >= 0 && remind <= 365 ? remind : 7,
    remind_meter: remindMeter,
    est_cost: estCost,
    notes: clip(t.notes, 1000),
    active: t.active !== false,
    updated_at: now,
  };
}

function validateLog(l: any, now: number): Log | string {
  if (!l || typeof l !== 'object') return 'bad_log';
  if (typeof l.id !== 'string' || !ID_RE.test(l.id)) return 'bad_id';
  if (typeof l.asset_id !== 'string' || !ID_RE.test(l.asset_id)) return 'bad_asset_id';
  const task_id = l.task_id == null ? null : String(l.task_id);
  if (task_id !== null && !ID_RE.test(task_id)) return 'bad_task_id';
  if (!KINDS.has(l.kind)) return 'bad_kind';
  if (!isDate(l.done_date)) return 'bad_date';
  const meter = num(l.meter, 1e9);
  const cost = num(l.cost);
  if (meter === 'bad' || cost === 'bad') return 'bad_number';
  return {
    id: l.id,
    asset_id: l.asset_id,
    task_id,
    kind: l.kind,
    done_date: l.done_date,
    title: clip(l.title, 160),
    meter,
    cost,
    provider: clip(l.provider, 120),
    note: clip(l.note, 2000),
    updated_at: clientTs(l.updated_at, now),
  };
}

function upsertLog(env: Env, l: Log, now: number): D1PreparedStatement {
  // last-write-wins ตาม updated_at — ข้อมูลที่ค้างส่งตอนออฟไลน์จะไม่ทับของที่ใหม่กว่า
  return env.DB.prepare(
    `INSERT INTO maint_logs (id, asset_id, task_id, kind, done_date, title, meter, cost, provider, note, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?12, ?11)
     ON CONFLICT(id) DO UPDATE SET asset_id = excluded.asset_id, task_id = excluded.task_id, kind = excluded.kind,
       done_date = excluded.done_date, title = excluded.title, meter = excluded.meter, cost = excluded.cost,
       provider = excluded.provider, note = excluded.note, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= maint_logs.updated_at`
  ).bind(l.id, l.asset_id, l.task_id, l.kind, l.done_date, l.title, l.meter, l.cost, l.provider, l.note, l.updated_at, now);
}

const listAll = async (env: Env) => {
  const [a, t, l] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM maint_assets ORDER BY active DESC, name'),
    env.DB.prepare('SELECT * FROM maint_tasks ORDER BY name'),
    env.DB.prepare('SELECT * FROM maint_logs WHERE deleted = 0 ORDER BY done_date DESC LIMIT 50000'),
  ]);
  return { assets: a.results.map(rowAsset), tasks: t.results.map(rowTask), logs: l.results.map(rowLog) };
};

// ---------- routes ----------
async function route(req: Request, env: Env, url: URL, now: number, sub: string): Promise<Response | null> {
  const method = req.method;

  if (sub === '/data' && method === 'GET') {
    const [all, categories] = await Promise.all([listAll(env), getCategories(env, CAT_SETTING, DEFAULT_CATEGORIES)]);
    return json({ ...all, categories });
  }

  if (sub === '/logs' && method === 'POST') {
    // สำหรับ iOS Shortcuts / สคริปต์: อ้างอุปกรณ์และงานด้วยชื่อหรือ id
    const body = await readJson(req);
    const all = await listAll(env);
    const key = clip(body?.asset, 120);
    const asset = all.assets.find((a) => a.id === key || a.name === key);
    if (!asset) return json({ error: 'unknown_asset', assets: all.assets.map((a) => a.name) }, 400);
    const tkey = clip(body?.task, 120);
    const task = tkey ? all.tasks.find((t) => t.asset_id === asset.id && (t.id === tkey || t.name === tkey)) : undefined;
    if (tkey && !task) return json({ error: 'unknown_task', tasks: all.tasks.filter((t) => t.asset_id === asset.id).map((t) => t.name) }, 400);
    const tz = await getTz(env);
    const v = validateLog(
      {
        id: crypto.randomUUID(),
        asset_id: asset.id,
        task_id: task ? task.id : null,
        kind: body?.kind ?? (task ? 'done' : body?.meter != null && !body?.note ? 'reading' : 'repair'),
        done_date: body?.date ?? localParts(now, tz).date,
        title: body?.title ?? (task ? task.name : ''),
        meter: body?.meter,
        cost: body?.cost,
        provider: body?.provider,
        note: body?.note,
        updated_at: now,
      },
      now
    );
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertLog(env, v, now).run();
    return json({ ok: true, log: v }, 201);
  }

  let id = pathId(sub, 'assets');
  if (id && method === 'PUT') {
    const body = await readJson(req);
    const v = validateAsset(id, body?.asset, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO maint_assets (id, name, category, location, brand, model, serial, purchase_date, price, warranty_until, warranty_remind_days,
         contact, notes, meter_unit, meter_start, meter_start_date, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, location = excluded.location,
         brand = excluded.brand, model = excluded.model, serial = excluded.serial, purchase_date = excluded.purchase_date,
         price = excluded.price, warranty_until = excluded.warranty_until, warranty_remind_days = excluded.warranty_remind_days,
         contact = excluded.contact, notes = excluded.notes, meter_unit = excluded.meter_unit, meter_start = excluded.meter_start,
         meter_start_date = excluded.meter_start_date, active = excluded.active, updated_at = excluded.updated_at`
    )
      .bind(v.id, v.name, v.category, v.location, v.brand, v.model, v.serial, v.purchase_date, v.price, v.warranty_until, v.warranty_remind_days,
        v.contact, v.notes, v.meter_unit, v.meter_start, v.meter_start_date, v.active ? 1 : 0, now)
      .run();
    const saved = await env.DB.prepare('SELECT * FROM maint_assets WHERE id = ?').bind(v.id).first();
    return json({ ok: true, asset: rowAsset(saved) });
  }
  if (id && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM maint_tasks WHERE asset_id = ?').bind(id),
      env.DB.prepare('UPDATE maint_logs SET deleted = 1, updated_at = ?2 WHERE asset_id = ?1').bind(id, now),
      env.DB.prepare('DELETE FROM maint_assets WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  id = pathId(sub, 'tasks');
  if (id && method === 'PUT') {
    const body = await readJson(req);
    const v = validateTask(id, body?.task, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO maint_tasks (id, asset_id, name, unit, every, every_meter, first_due, first_due_meter, remind_days, remind_meter, est_cost, notes, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
       ON CONFLICT(id) DO UPDATE SET asset_id = excluded.asset_id, name = excluded.name, unit = excluded.unit, every = excluded.every,
         every_meter = excluded.every_meter, first_due = excluded.first_due, first_due_meter = excluded.first_due_meter,
         remind_days = excluded.remind_days, remind_meter = excluded.remind_meter, est_cost = excluded.est_cost,
         notes = excluded.notes, active = excluded.active, updated_at = excluded.updated_at`
    )
      .bind(v.id, v.asset_id, v.name, v.unit, v.every, v.every_meter, v.first_due, v.first_due_meter, v.remind_days, v.remind_meter, v.est_cost, v.notes, v.active ? 1 : 0, now)
      .run();
    const saved = await env.DB.prepare('SELECT * FROM maint_tasks WHERE id = ?').bind(v.id).first();
    return json({ ok: true, task: rowTask(saved) });
  }
  if (id && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM maint_tasks WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return categoryRoutes(req, env, sub, CAT_SETTING, DEFAULT_CATEGORIES);
}

function syncOp(env: Env, op: any, now: number): D1PreparedStatement | string {
  if (op?.type === 'put') {
    const v = validateLog(op.item, now);
    return typeof v === 'string' ? v : upsertLog(env, v, now);
  }
  if (op?.type === 'del') {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return 'bad_id';
    return env.DB.prepare('UPDATE maint_logs SET deleted = 1, updated_at = ?2 WHERE id = ?1 AND updated_at <= ?2').bind(op.id, clientTs(op.updated_at, now));
  }
  return 'bad_op';
}

// ---------- สรุปประจำวัน ----------
const fmtN = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 0 });

export function itemsToRemind(assets: Asset[], tasks: Task[], logs: Log[], today: string): DigestItem[] {
  const items: DigestItem[] = [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const t of tasks) {
    const a = byId.get(t.asset_id);
    if (!t.active || !a || !a.active) continue;
    const s = taskStatus(t, a, logs, today);
    if (s.state !== 'overdue' && s.state !== 'soon') continue;
    const unit = a.meter_unit || 'หน่วย';
    const bits: string[] = [];
    if (s.days_left != null) bits.push(s.days_left < 0 ? `เลย ${-s.days_left} วัน` : s.days_left === 0 ? 'วันนี้' : `อีก ${s.days_left} วัน`);
    if (s.meter_left != null) bits.push(s.meter_left <= 0 ? `เกิน ${fmtN(-s.meter_left)} ${unit}` : `อีก ${fmtN(s.meter_left)} ${unit}`);
    items.push({ sort: s.sort, overdue: s.state === 'overdue', line: `${t.name} — ${a.name} (${bits.join(', ') || 'ครบกำหนด'})` });
  }
  for (const a of assets) {
    if (!a.active) continue;
    const w = warrantyLeft(a, today);
    if (w != null && w >= 0 && w <= a.warranty_remind_days) {
      items.push({ sort: w, overdue: false, line: `ประกัน ${a.name} หมด${w === 0 ? 'วันนี้' : `ในอีก ${w} วัน`}` });
    }
  }
  return items;
}

export const maint: Module = {
  id: 'maint',
  label: 'ดูแลอุปกรณ์',
  emoji: '🔧',
  route,
  syncOp,
  async digest(env, today) {
    const all = await listAll(env);
    return itemsToRemind(all.assets, all.tasks, all.logs, today);
  },
};
