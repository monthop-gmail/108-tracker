/**
 * โมดูลค่าใช้จ่าย: รายการที่ตั้งไว้ (bills) และการจ่าย (payments)
 *
 *   GET    /api/bills/data?since=YYYY-MM-DD  → {bills, payments, categories}  (payments ตั้งแต่ since; ค่าเริ่มต้น ~26 เดือน)
 *   GET    /api/bills/payments?from=&to=     → การจ่ายตามช่วงวันที่จ่าย (ใช้ดูประวัติเก่า)
 *   POST   /api/bills/payments               {name, amount, category?, paid_date?, method?, note?}  → บันทึกจ่ายครั้งเดียว (Shortcuts/สคริปต์)
 *   PUT    /api/bills/items/:id              {bill}
 *   DELETE /api/bills/items/:id
 *   GET/PUT /api/bills/categories, POST /api/bills/categories/reset
 *   sync: {mod:'bills', type:'put', item: payment} | {mod:'bills', type:'del', id, updated_at}
 */
import { Env, json, readJson, ID_RE, clip, isDate, clientTs, localParts, getTz } from '../core/util';
import { Module, Category, DigestItem, categoryRoutes, getCategories, isCatKey, pathId } from '../core/module';
// ตรรกะคำนวณงวดใช้ไฟล์เดียวกับหน้าเว็บ
import { pendingFor, addDays } from '../../public/modules/bills/schedule.js';

export type Bill = {
  id: string;
  name: string;
  category: string;
  amount: number | null;
  unit: 'once' | 'week' | 'month' | 'year';
  every: number;
  start_due: string;
  end_date: string | null;
  count: number | null;
  remind_days: number;
  autopay: boolean;
  method: string;
  details: string;
  active: boolean;
  created_at?: number;
  updated_at: number;
};
export type Payment = {
  id: string;
  bill_id: string | null;
  period: string | null;
  paid_date: string;
  name: string;
  category: string;
  amount: number | null;
  method: string;
  note: string;
  status: 'paid' | 'skipped';
  updated_at: number;
};

export const DEFAULT_CATEGORIES: Category[] = [
  { key: 'home', label: 'บ้าน/ที่พัก', emoji: '🏠' },
  { key: 'utility', label: 'น้ำ-ไฟ', emoji: '💡' },
  { key: 'phone', label: 'โทรศัพท์/เน็ต', emoji: '📶' },
  { key: 'card', label: 'บัตรเครดิต/ผ่อน', emoji: '💳' },
  { key: 'insurance', label: 'ประกัน', emoji: '🛡️' },
  { key: 'tax', label: 'ภาษี/ค่าธรรมเนียม', emoji: '🧾' },
  { key: 'car', label: 'รถ/เดินทาง', emoji: '🚗' },
  { key: 'subscription', label: 'สมาชิก/บริการ', emoji: '📺' },
  { key: 'education', label: 'การศึกษา', emoji: '🎓' },
  { key: 'health', label: 'สุขภาพ', emoji: '🩺' },
  { key: 'family', label: 'ครอบครัว/ทำบุญ', emoji: '🎁' },
  { key: 'other', label: 'อื่น ๆ', emoji: '📦' },
];
const CAT_SETTING = 'bills.categories';
const UNITS = new Set(['once', 'week', 'month', 'year']);

const money = (v: unknown): number | null | string => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e10) return 'bad_amount';
  return Math.round(n * 100) / 100;
};

// ---------- รายการ (bill) ----------
function rowBill(r: any): Bill {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    amount: r.amount ?? null,
    unit: r.unit,
    every: r.every,
    start_due: r.start_due,
    end_date: r.end_date ?? null,
    count: r.count ?? null,
    remind_days: r.remind_days,
    autopay: !!r.autopay,
    method: r.method,
    details: r.details,
    active: !!r.active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function validateBill(id: string, b: any, now: number): Bill | string {
  if (!b || typeof b !== 'object') return 'bad_bill';
  const name = clip(b.name, 120);
  if (!name) return 'name_required';
  const amount = money(b.amount);
  if (typeof amount === 'string') return amount;
  if (!UNITS.has(b.unit)) return 'bad_unit';
  const every = Number(b.every ?? 1);
  if (!Number.isInteger(every) || every < 1 || every > 60) return 'bad_every';
  if (!isDate(b.start_due)) return 'bad_start_due';
  const end = b.end_date == null || b.end_date === '' ? null : b.end_date;
  if (end !== null && (!isDate(end) || end < b.start_due)) return 'bad_end_date';
  const count = b.count == null || b.count === '' ? null : Number(b.count);
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 600)) return 'bad_count';
  const remind = Number(b.remind_days ?? 3);
  if (!Number.isInteger(remind) || remind < 0 || remind > 60) return 'bad_remind_days';
  return {
    id,
    name,
    category: isCatKey(b.category) ? b.category : 'other',
    amount,
    unit: b.unit,
    every: b.unit === 'once' ? 1 : every,
    start_due: b.start_due,
    end_date: b.unit === 'once' ? null : end,
    count: b.unit === 'once' ? null : count,
    remind_days: remind,
    autopay: !!b.autopay,
    method: clip(b.method, 30),
    details: clip(b.details, 1000),
    active: b.active !== false,
    updated_at: now,
  };
}

async function listBills(env: Env): Promise<Bill[]> {
  const { results } = await env.DB.prepare('SELECT * FROM bills_items ORDER BY active DESC, name').all();
  return results.map(rowBill);
}

// ---------- การจ่าย (payment) ----------
function rowPayment(r: any): Payment {
  return {
    id: r.id,
    bill_id: r.bill_id ?? null,
    period: r.period ?? null,
    paid_date: r.paid_date,
    name: r.name,
    category: r.category,
    amount: r.amount ?? null,
    method: r.method,
    note: r.note,
    status: r.status === 'skipped' ? 'skipped' : 'paid',
    updated_at: r.updated_at,
  };
}

function validatePayment(p: any, now: number): Payment | string {
  if (!p || typeof p !== 'object') return 'bad_payment';
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'bad_id';
  const bill_id = p.bill_id == null ? null : String(p.bill_id);
  if (bill_id !== null && !ID_RE.test(bill_id)) return 'bad_bill_id';
  const period = p.period == null ? null : p.period;
  if (period !== null && !isDate(period)) return 'bad_period';
  if (!isDate(p.paid_date)) return 'bad_paid_date';
  const name = clip(p.name, 120);
  if (!name) return 'name_required';
  const amount = money(p.amount);
  if (typeof amount === 'string') return amount;
  return {
    id: p.id,
    bill_id,
    period,
    paid_date: p.paid_date,
    name,
    category: isCatKey(p.category) ? p.category : 'other',
    amount,
    method: clip(p.method, 30),
    note: clip(p.note, 1000),
    status: p.status === 'skipped' ? 'skipped' : 'paid',
    updated_at: clientTs(p.updated_at, now),
  };
}

function upsertPayment(env: Env, p: Payment, now: number): D1PreparedStatement {
  // last-write-wins ตาม updated_at — ข้อมูลที่ค้างส่งตอนออฟไลน์จะไม่ทับของที่ใหม่กว่า
  return env.DB.prepare(
    `INSERT INTO bills_payments (id, bill_id, period, paid_date, name, category, amount, method, note, status, deleted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?12, ?11)
     ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, period = excluded.period, paid_date = excluded.paid_date,
       name = excluded.name, category = excluded.category, amount = excluded.amount, method = excluded.method,
       note = excluded.note, status = excluded.status, deleted = 0, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= bills_payments.updated_at`
  ).bind(p.id, p.bill_id, p.period, p.paid_date, p.name, p.category, p.amount, p.method, p.note, p.status, p.updated_at, now);
}

// ---------- routes ----------
async function route(req: Request, env: Env, url: URL, now: number, sub: string): Promise<Response | null> {
  const method = req.method;

  if (sub === '/data' && method === 'GET') {
    const sinceQ = url.searchParams.get('since');
    const since = isDate(sinceQ) ? sinceQ : addDays(new Date(now).toISOString().slice(0, 10), -800);
    const [list, categories, pays] = await Promise.all([
      listBills(env),
      getCategories(env, CAT_SETTING, DEFAULT_CATEGORIES),
      env.DB.prepare(`SELECT * FROM bills_payments WHERE deleted = 0 AND (paid_date >= ?1 OR period >= ?1) ORDER BY paid_date DESC LIMIT 20000`)
        .bind(since)
        .all(),
    ]);
    return json({ bills: list, categories, payments: pays.results.map(rowPayment), since });
  }

  if (sub === '/payments' && method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const { results } = await env.DB.prepare(
      'SELECT * FROM bills_payments WHERE deleted = 0 AND paid_date >= ?1 AND paid_date <= ?2 ORDER BY paid_date DESC LIMIT 20000'
    )
      .bind(isDate(from) ? from : '2000-01-01', isDate(to) ? to : '2199-12-31')
      .all();
    return json({ payments: results.map(rowPayment) });
  }

  if (sub === '/payments' && method === 'POST') {
    const body = await readJson(req);
    const tz = await getTz(env);
    const cats = await getCategories(env, CAT_SETTING, DEFAULT_CATEGORIES);
    const rawCat = clip(body?.category, 40);
    const cat = cats.find((c) => c.key === rawCat || c.label === rawCat)?.key ?? 'other';
    const v = validatePayment(
      {
        id: crypto.randomUUID(),
        bill_id: null,
        period: null,
        paid_date: body?.paid_date ?? localParts(now, tz).date,
        name: body?.name,
        category: cat,
        amount: body?.amount,
        method: body?.method,
        note: body?.note,
        status: 'paid',
        updated_at: now,
      },
      now
    );
    if (typeof v === 'string') return json({ error: v }, 400);
    await upsertPayment(env, v, now).run();
    return json({ ok: true, payment: v }, 201);
  }

  const id = pathId(sub, 'items');
  if (id && method === 'PUT') {
    const body = await readJson(req);
    const v = validateBill(id, body?.bill, now);
    if (typeof v === 'string') return json({ error: v }, 400);
    await env.DB.prepare(
      `INSERT INTO bills_items (id, name, category, amount, unit, every, start_due, end_date, count, remind_days, autopay, method, details, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, amount = excluded.amount, unit = excluded.unit,
         every = excluded.every, start_due = excluded.start_due, end_date = excluded.end_date, count = excluded.count,
         remind_days = excluded.remind_days, autopay = excluded.autopay, method = excluded.method, details = excluded.details,
         active = excluded.active, updated_at = excluded.updated_at`
    )
      .bind(v.id, v.name, v.category, v.amount, v.unit, v.every, v.start_due, v.end_date, v.count, v.remind_days, v.autopay ? 1 : 0, v.method, v.details, v.active ? 1 : 0, now)
      .run();
    const saved = await env.DB.prepare('SELECT * FROM bills_items WHERE id = ?').bind(v.id).first();
    return json({ ok: true, bill: rowBill(saved) });
  }
  if (id && method === 'DELETE') {
    // ลบเฉพาะรายการตั้งไว้ ประวัติการจ่ายยังอยู่ (มีชื่อ/หมวดเก็บไว้ในตัวเอง)
    await env.DB.prepare('DELETE FROM bills_items WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return categoryRoutes(req, env, sub, CAT_SETTING, DEFAULT_CATEGORIES);
}

function syncOp(env: Env, op: any, now: number): D1PreparedStatement | string {
  if (op?.type === 'put') {
    const v = validatePayment(op.item, now);
    return typeof v === 'string' ? v : upsertPayment(env, v, now);
  }
  if (op?.type === 'del') {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return 'bad_id';
    return env.DB.prepare('UPDATE bills_payments SET deleted = 1, updated_at = ?2 WHERE id = ?1 AND updated_at <= ?2').bind(op.id, clientTs(op.updated_at, now));
  }
  return 'bad_op';
}

// ---------- สรุปประจำวัน ----------
const baht = (n: number | null) => {
  if (n == null) return '';
  const frac = Math.round(n * 100) % 100 ? 2 : 0;
  return ` ฿${n.toLocaleString('th-TH', { minimumFractionDigits: frac, maximumFractionDigits: 2 })}`;
};

function dueLabel(days: number): string {
  if (days < 0) return `เลยกำหนด ${-days} วัน`;
  if (days === 0) return 'ครบกำหนดวันนี้';
  if (days === 1) return 'พรุ่งนี้';
  return `อีก ${days} วัน`;
}

/** รายการที่ควรเตือนวันนี้: เลยกำหนด + ใกล้ครบตามจำนวนวันที่ตั้งไว้ของแต่ละรายการ */
export function itemsToRemind(list: Bill[], payments: Payment[], today: string): DigestItem[] {
  const items: { bill: Bill; days: number }[] = [];
  for (const b of list) {
    if (!b.active) continue;
    const { overdue, next } = pendingFor(b, payments, today, 61);
    for (const o of overdue) items.push({ bill: b, days: o.days });
    if (next && next.days <= b.remind_days) items.push({ bill: b, days: next.days });
  }
  return items
    .sort((a, b) => a.days - b.days || a.bill.name.localeCompare(b.bill.name))
    .map((i) => ({
      sort: i.days,
      overdue: i.days < 0,
      line: `${i.bill.name}${baht(i.bill.amount)} — ${dueLabel(i.days)}${i.bill.autopay ? ' (หักอัตโนมัติ)' : ''}`,
    }));
}

export const bills: Module = {
  id: 'bills',
  label: 'ค่าใช้จ่าย',
  emoji: '💸',
  route,
  syncOp,
  async digest(env, today) {
    const list = await listBills(env);
    const { results } = await env.DB.prepare('SELECT * FROM bills_payments WHERE deleted = 0 AND bill_id IS NOT NULL AND period >= ?')
      .bind(addDays(today, -800))
      .all();
    return itemsToRemind(list, results.map(rowPayment), today);
  },
};
