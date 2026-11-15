/**
 * โมดูลของในบ้าน: ของที่มี จำนวน จุดสั่งซื้อ วันหมดอายุ และรายการซื้อของ
 * ทั้งของในบ้านและรายการซื้อแก้ได้ตอนออฟไลน์ (เช่น ติ๊กของระหว่างอยู่ในห้าง) แล้วซิงก์ผ่าน /api/sync
 *
 *   GET    /api/pantry/data                 → {items, shop, places}
 *   POST   /api/pantry/use   {name, qty?=1}  → ใช้ของไป (ลดจำนวน) — สำหรับ Shortcuts/สคริปต์
 *   POST   /api/pantry/shop  {name, qty?, unit?, note?}  → เพิ่มของในรายการซื้อ — สำหรับ Shortcuts/สคริปต์
 *   GET/PUT /api/pantry/categories, POST /api/pantry/categories/reset  (ที่เก็บของ)
 *   sync: {mod:'pantry', table:'items'|'shop', type:'put', item} | {mod:'pantry', table, type:'del', id, updated_at}
 */
import { Env, json, readJson, ID_RE, clip, optDate, num, clientTs } from '../core/util';
import { Module, Category, DigestItem, categoryRoutes, getCategories, isCatKey } from '../core/module';
import { expiryLeft, isLow } from '../../public/modules/pantry/logic.js';

export type Item = {
  id: string;
  name: string;
  place: string;
  qty: number;
  unit: string;
  min_qty: number | null;
  buy_qty: number | null;
  expires_on: string | null;
  remind_days: number;
  price: number | null;
  shop: string;
  note: string;
  updated_at: number;
};
export type ShopEntry = {
  id: string;
  item_id: string | null;
  name: string;
  qty: number | null;
  unit: string;
  note: string;
  done_at: number | null;
  updated_at: number;
};

export const DEFAULT_PLACES: Category[] = [
  { key: 'fridge', label: 'ตู้เย็น', emoji: '🥛' },
  { key: 'freezer', label: 'ช่องแช่แข็ง', emoji: '🧊' },
  { key: 'kitchen', label: 'ครัว/ตู้กับข้าว', emoji: '🍚' },
  { key: 'bathroom', label: 'ห้องน้ำ/ของใช้ส่วนตัว', emoji: '🧴' },
  { key: 'cleaning', label: 'ของใช้ทำความสะอาด', emoji: '🧽' },
  { key: 'medicine', label: 'ยาสามัญ/ปฐมพยาบาล', emoji: '🩹' },
  { key: 'other', label: 'อื่น ๆ', emoji: '📦' },
];
const PLACE_SETTING = 'pantry.places';

const rowItem = (r: any): Item => {
  const { deleted, created_at, ...rest } = r;
  return rest;
};
const rowShop = (r: any): ShopEntry => {
  const { deleted, created_at, ...rest } = r;
  return rest;
};

function validateItem(it: any, now: number): Item | string {
  if (!it || typeof it !== 'object') return 'bad_item';
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) return 'bad_id';
  const name = clip(it.name, 120);
  if (!name) return 'name_required';
  const qty = num(it.qty ?? 0, 1e6);
  const min = num(it.min_qty, 1e6);
  const buy = num(it.buy_qty, 1e6);
  const price = num(it.price);
  if (qty === 'bad' || qty === null || min === 'bad' || buy === 'bad' || price === 'bad') return 'bad_number';
  const exp = optDate(it.expires_on);
  if (exp === 'bad') return 'bad_date';
  const rd = Number(it.remind_days ?? 3);
  return {
    id: it.id,
    name,
    place: isCatKey(it.place) ? it.place : 'other',
    qty,
    unit: clip(it.unit, 20),
    min_qty: min,
    buy_qty: buy,
    expires_on: exp,
    remind_days: Number.isInteger(rd) && rd >= 0 && rd <= 365 ? rd : 3,
    price,
    shop: clip(it.shop, 80),
    note: clip(it.note, 500),
    updated_at: clientTs(it.updated_at, now),
  };
}

function validateShop(s: any, now: number): ShopEntry | string {
  if (!s || typeof s !== 'object') return 'bad_shop';
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return 'bad_id';
  const item_id = s.item_id == null ? null : String(s.item_id);
  if (item_id !== null && !ID_RE.test(item_id)) return 'bad_item_id';
  const name = clip(s.name, 120);
  if (!name) return 'name_required';
  const qty = num(s.qty, 1e6);
  if (qty === 'bad') return 'bad_number';
  const done = s.done_at == null ? null : Number(s.done_at);
  if (done !== null && (!Number.isFinite(done) || done < 0)) return 'bad_done_at';
  return {
    id: s.id,
    item_id,
    name,
    qty,
    unit: clip(s.unit, 20),
    note: clip(s.note, 300),
    done_at: done === null ? null : Math.round(done),
    updated_at: clientTs(s.updated_at, now),
  };
}

function upsertItem(env: Env, v: Item, now: number): D1PreparedStatement {
  // last-write-wins ตาม updated_at
  return env.DB.prepare(
    `INSERT INTO pantry_items (id, name, place, qty, unit, min_qty, buy_qty, expires_on, remind_days, price, shop, note, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?14, ?13)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, place = excluded.place, qty = excluded.qty, unit = excluded.unit,
       min_qty = excluded.min_qty, buy_qty = excluded.buy_qty, expires_on = excluded.expires_on, remind_days = excluded.remind_days,
       price = excluded.price, shop = excluded.shop, note = excluded.note, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= pantry_items.updated_at`
  ).bind(v.id, v.name, v.place, v.qty, v.unit, v.min_qty, v.buy_qty, v.expires_on, v.remind_days, v.price, v.shop, v.note, v.updated_at, now);
}

function upsertShop(env: Env, v: ShopEntry, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO pantry_shop (id, item_id, name, qty, unit, note, done_at, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?9, ?8)
     ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, qty = excluded.qty, unit = excluded.unit,
       note = excluded.note, done_at = excluded.done_at, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= pantry_shop.updated_at`
  ).bind(v.id, v.item_id, v.name, v.qty, v.unit, v.note, v.done_at, v.updated_at, now);
}

async function listAll(env: Env, now: number) {
  const [items, shop] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM pantry_items WHERE deleted = 0 ORDER BY name'),
    // รายการที่ซื้อแล้วเก็บไว้ดู 30 วัน
    env.DB.prepare('SELECT * FROM pantry_shop WHERE deleted = 0 AND (done_at IS NULL OR done_at > ?) ORDER BY created_at').bind(now - 30 * 86400000),
  ]);
  return { items: items.results.map(rowItem), shop: shop.results.map(rowShop) };
}

const findByName = (items: Item[], key: string) => {
  const k = key.trim().toLowerCase();
  return items.find((i) => i.id === key) || items.find((i) => i.name.toLowerCase() === k) || items.find((i) => i.name.toLowerCase().includes(k));
};

async function route(req: Request, env: Env, url: URL, now: number, sub: string): Promise<Response | null> {
  const method = req.method;

  if (sub === '/data' && method === 'GET') {
    const [all, places] = await Promise.all([listAll(env, now), getCategories(env, PLACE_SETTING, DEFAULT_PLACES)]);
    return json({ ...all, places });
  }

  if (sub === '/use' && method === 'POST') {
    const body = await readJson(req);
    const { items } = await listAll(env, now);
    const it = findByName(items, clip(body?.name, 120));
    if (!it) return json({ error: 'unknown_item', items: items.map((i) => i.name) }, 400);
    const used = num(body?.qty ?? 1, 1e6);
    if (used === 'bad' || used === null) return json({ error: 'bad_number' }, 400);
    const v = validateItem({ ...it, qty: Math.max(0, Math.round((it.qty - used) * 100) / 100), updated_at: now }, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertItem(env, v, now).run();
    return json({ ok: true, item: v, low: isLow(v) });
  }

  if (sub === '/shop' && method === 'POST') {
    const body = await readJson(req);
    const { items } = await listAll(env, now);
    const name = clip(body?.name, 120);
    const it = name ? findByName(items, name) : undefined;
    const v = validateShop(
      { id: crypto.randomUUID(), item_id: it ? it.id : null, name: it ? it.name : name, qty: body?.qty, unit: body?.unit ?? (it ? it.unit : ''), note: body?.note, done_at: null, updated_at: now },
      now
    );
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertShop(env, v, now).run();
    return json({ ok: true, entry: v }, 201);
  }

  return categoryRoutes(req, env, sub, PLACE_SETTING, DEFAULT_PLACES);
}

function syncOp(env: Env, op: any, now: number): D1PreparedStatement | string {
  const table = op?.table === 'shop' ? 'pantry_shop' : op?.table === 'items' ? 'pantry_items' : null;
  if (!table) return 'bad_table';
  if (op.type === 'put') {
    const v = table === 'pantry_items' ? validateItem(op.item, now) : validateShop(op.item, now);
    if (typeof v === 'string') return v;
    return table === 'pantry_items' ? upsertItem(env, v as Item, now) : upsertShop(env, v as ShopEntry, now);
  }
  if (op.type === 'del') {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return 'bad_id';
    return env.DB.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ?2 WHERE id = ?1 AND updated_at <= ?2`).bind(op.id, clientTs(op.updated_at, now));
  }
  return 'bad_op';
}

const fmtQ = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });

export function itemsToRemind(items: Item[], shop: ShopEntry[], today: string): DigestItem[] {
  const out: DigestItem[] = [];
  for (const it of items) {
    const d = expiryLeft(it, today);
    if (d == null || it.qty <= 0 || d > it.remind_days) continue;
    out.push({
      sort: d,
      overdue: d < 0,
      line: `${it.name} ${d < 0 ? `หมดอายุแล้ว ${-d} วัน` : d === 0 ? 'หมดอายุวันนี้' : d === 1 ? 'หมดอายุพรุ่งนี้' : `หมดอายุในอีก ${d} วัน`}`,
    });
  }
  const low = items.filter(isLow);
  const manual = shop.filter((s) => !s.done_at && !(s.item_id && low.some((i) => i.id === s.item_id)));
  const names = [...low.map((i) => `${i.name}${i.qty > 0 ? ` (เหลือ ${fmtQ(i.qty)}${i.unit ? ` ${i.unit}` : ''})` : ''}`), ...manual.map((s) => s.name)];
  if (names.length) {
    const shown = names.slice(0, 6).join(', ');
    out.push({ sort: 1000, overdue: false, line: `ต้องซื้อ ${names.length} อย่าง: ${shown}${names.length > 6 ? ' …' : ''}` });
  }
  return out;
}

export const pantry: Module = {
  id: 'pantry',
  label: 'ของในบ้าน',
  emoji: '🧺',
  route,
  syncOp,
  async digest(env, today, now) {
    const { items, shop } = await listAll(env, now);
    return itemsToRemind(items, shop, today);
  },
};
