/* โมดูลดูแลอุปกรณ์ — อุปกรณ์ งานดูแลตามรอบ (เวลา/เลขไมล์) ประวัติซ่อม ประกัน
 * - บันทึก (ทำแล้ว/ซ่อม/จดเลขไมล์) เก็บลงเครื่องก่อน แล้วส่งขึ้นเซิร์ฟเวอร์ผ่าน outbox กลาง → ใช้ได้แม้เน็ตหลุด
 * - การคำนวณรอบใช้ schedule.js ไฟล์เดียวกับฝั่ง Worker
 */
import { $, $$, esc, store, today, dateObj, F_WD, F_MON, fmtFull, baht, fmtN, monthOf, monthLabel, uuid, parseNum, ICON, download, csv, sheetHead } from '../../core/util.js';
import { CatEditor } from '../../core/cats.js';
import { taskStatus, meterNow, usageRate, intervalText, warrantyLeft, addInterval, addDays, addMonths } from './schedule.js';

const ID = 'maint';
let ctx;
let sheetEl;
const api = (...a) => ctx.api(...a);
const toast = (...a) => ctx.toast(...a);
const handleErr = (e) => ctx.handleErr(e);
const rerender = () => ctx.rerender();
const openSheet = (html) => ctx.openSheet(mod, html);
const closeSheet = () => ctx.closeSheet();
const go = (hash) => (location.hash = hash);

// ---------- ค่าคงที่ ----------
const FALLBACK_CATS = [{ key: 'other', label: 'อื่น ๆ', emoji: '📦' }];
const UNIT_TH = { day: 'วัน', week: 'สัปดาห์', month: 'เดือน', year: 'ปี' };
const FREQS = [
  ['month', 1, 'ทุกเดือน'],
  ['month', 3, 'ทุก 3 เดือน'],
  ['month', 6, 'ทุก 6 เดือน'],
  ['year', 1, 'ทุกปี'],
  ['once', null, 'ครั้งเดียว'],
];
const KIND = {
  done: { icon: '✅', label: 'ดูแลตามรอบ' },
  repair: { icon: '🔧', label: 'ซ่อม/เปลี่ยนอะไหล่' },
  reading: { icon: '📏', label: 'จดเลขไมล์' },
  note: { icon: '📝', label: 'บันทึกอื่น' },
};
// งานแนะนำตามประเภทอุปกรณ์: [ชื่อ, ทุกกี่, หน่วย, ทุกกี่ กม., เลือกไว้ก่อน]
const TEMPLATES = {
  car: {
    meter: 'กม.',
    tasks: [
      ['เปลี่ยนน้ำมันเครื่อง', 6, 'month', 10000, true],
      ['ตรวจลมยาง', 1, 'month', null, true],
      ['เปลี่ยนไส้กรองอากาศ/แอร์รถ', 1, 'year', 20000, false],
      ['สลับยาง', 1, 'year', 10000, false],
      ['เปลี่ยนน้ำมันเบรก', 2, 'year', 40000, false],
      ['เปลี่ยนแบตเตอรี่', 2, 'year', null, false],
      ['เปลี่ยนยาง', 4, 'year', 50000, false],
    ],
  },
  motorcycle: {
    meter: 'กม.',
    tasks: [
      ['เปลี่ยนน้ำมันเครื่อง', 3, 'month', 3000, true],
      ['เช็กโซ่/สายพาน', 6, 'month', 6000, false],
      ['เปลี่ยนยาง', 2, 'year', 15000, false],
    ],
  },
  aircon: { tasks: [['ล้างแอร์', 6, 'month', null, true], ['ล้างฟิลเตอร์', 1, 'month', null, false]] },
  appliance: {
    tasks: [
      ['ล้างถังเครื่องซักผ้า', 1, 'month', null, false],
      ['ทำความสะอาดแผงคอยล์ตู้เย็น', 6, 'month', null, false],
      ['ล้างเครื่องทำน้ำอุ่น/หัวฝักบัว', 6, 'month', null, false],
    ],
  },
  water: { tasks: [['เปลี่ยนไส้กรองน้ำ', 6, 'month', null, true], ['ตรวจปั๊มน้ำ', 6, 'month', null, false], ['ล้างแท็งก์น้ำ', 1, 'year', null, false]] },
  electronics: { tasks: [['สำรองข้อมูล', 1, 'month', null, true], ['ทำความสะอาด/เป่าฝุ่น', 1, 'year', null, false], ['อัปเดตระบบ', 3, 'month', null, false]] },
  safety: {
    tasks: [
      ['ตรวจเกจถังดับเพลิง', 1, 'month', null, true],
      ['เปลี่ยนถ่านเครื่องตรวจจับควัน', 1, 'year', null, false],
      ['อัดสาร/เปลี่ยนถังดับเพลิง', 5, 'year', null, false],
    ],
  },
  home: { tasks: [['ล้างรางน้ำฝน', 1, 'year', null, true], ['ฉีดกันปลวก', 1, 'year', null, false], ['ตรวจรอยรั่วหลังคา', 1, 'year', null, false]] },
  garden: { tasks: [['ลับใบมีด/ดูแลเครื่องตัดหญ้า', 1, 'year', null, true]] },
};
// ---------- state ----------
const CACHE = 't108_maint';
const cache = store.get(CACHE, {});
const state = {
  assets: cache.assets || [],
  tasks: cache.tasks || [],
  categories: cache.categories || FALLBACK_CATS,
  logs: new Map((cache.logs || []).map((l) => [l.id, l])),
  touched: new Map(),
  hist: { month: monthOf(today()), q: '' },
};

const catOf = (key) => state.categories.find((c) => c.key === key) || { key, label: key || 'อื่น ๆ', emoji: '📦' };
const assetOf = (id) => state.assets.find((a) => a.id === id);
const taskOf = (id) => state.tasks.find((t) => t.id === id);
const logList = () => [...state.logs.values()];
const pendingIds = () => ctx.pendingIds(ID);

function saveCache() {
  store.set(CACHE, { assets: state.assets, tasks: state.tasks, categories: state.categories, logs: logList().slice(0, 8000) });
}

function saveLog(l) {
  const log = {
    id: l.id,
    asset_id: l.asset_id,
    task_id: l.task_id ?? null,
    kind: l.kind,
    done_date: l.done_date,
    title: (l.title || '').trim(),
    meter: l.meter ?? null,
    cost: l.cost ?? null,
    provider: (l.provider || '').trim(),
    note: (l.note || '').trim(),
    updated_at: Date.now(),
  };
  state.logs.set(log.id, log);
  state.touched.set(log.id, { at: log.updated_at, log });
  ctx.queue(ID, { type: 'put', item: log });
  saveCache();
  rerender();
  return log;
}

function deleteLog(id, { silent } = {}) {
  const old = state.logs.get(id);
  if (!old) return;
  const at = Date.now();
  state.logs.delete(id);
  state.touched.set(id, { at, log: null });
  ctx.queue(ID, { type: 'del', id, updated_at: at });
  saveCache();
  rerender();
  if (!silent) toast('ลบแล้ว', { label: 'เลิกทำ', fn: () => saveLog(old) });
}

async function refresh() {
  const t0 = Date.now();
  const r = await api('/api/maint/data');
  const map = new Map(r.logs.map((l) => [l.id, l]));
  ctx.applyOutbox(ID, '', map);
  for (const [id, t] of state.touched) {
    if (t.at >= t0 - 2000) t.log ? map.set(id, t.log) : map.delete(id);
    else if (Date.now() - t.at > 5 * 60000) state.touched.delete(id);
  }
  state.assets = r.assets;
  state.tasks = r.tasks;
  state.categories = r.categories;
  state.logs = map;
  saveCache();
}

function toCSV(list) {
  const rows = [['วันที่', 'อุปกรณ์', 'ประเภทบันทึก', 'รายการ', 'เลขไมล์', 'ค่าใช้จ่าย', 'ผู้ทำ/ร้าน', 'หมายเหตุ']];
  for (const l of [...list].sort((a, b) => a.done_date.localeCompare(b.done_date))) {
    const a = assetOf(l.asset_id);
    rows.push([l.done_date, a ? a.name : '', KIND[l.kind]?.label || l.kind, logTitle(l), l.meter ?? '', l.cost ?? '', l.provider, l.note]);
  }
  return csv(rows);
}

// ---------- ข้อมูลที่คำนวณ ----------
function statuses({ includeInactive = false } = {}) {
  const t = today();
  const logs = logList();
  const out = [];
  for (const task of state.tasks) {
    const a = assetOf(task.asset_id);
    if (!a) continue;
    if (!includeInactive && (!task.active || !a.active)) continue;
    out.push({ task, asset: a, s: taskStatus(task, a, logs, t) });
  }
  return out;
}

function dueText(s, asset) {
  const unit = asset.meter_unit || 'หน่วย';
  const bits = [];
  if (s.days_left != null) bits.push(s.days_left < 0 ? `เลยกำหนด ${-s.days_left} วัน` : s.days_left === 0 ? 'ครบกำหนดวันนี้' : s.days_left === 1 ? 'พรุ่งนี้' : `อีก ${s.days_left} วัน`);
  if (s.meter_left != null) bits.push(s.meter_left <= 0 ? `เกินระยะ ${fmtN(-s.meter_left)} ${unit}` : `อีก ${fmtN(s.meter_left)} ${unit}${s.est_days != null ? ` (≈ ${s.est_days} วัน)` : ''}`);
  if (!bits.length) return s.state === 'done' ? 'ทำแล้ว' : s.due_meter != null ? `ครบที่ ${fmtN(s.due_meter)} ${unit} (ยังไม่มีเลขไมล์ปัจจุบัน)` : 'ยังไม่ได้กำหนดครั้งแรก';
  return bits.join(' · ');
}

const logTitle = (l) => l.title || (l.task_id && taskOf(l.task_id) ? taskOf(l.task_id).name : KIND[l.kind]?.label || '');

function warrantyText(a) {
  const w = warrantyLeft(a, today());
  if (w == null) return '';
  if (w < 0) return `ประกันหมดแล้ว (${fmtFull(a.warranty_until)})`;
  if (w === 0) return 'ประกันหมดวันนี้';
  return `ประกันถึง ${fmtFull(a.warranty_until)} (อีก ${w} วัน)`;
}
// ---------- แถวงาน / แถวบันทึก ----------
function taskRow({ task, asset, s }, { showAsset = true } = {}) {
  const c = catOf(asset.category);
  let badge;
  // ถ้าระยะไมล์จะถึงก่อนวันที่ ให้ป้ายแสดงเลขไมล์แทน
  const meterFirst =
    s.due_meter != null &&
    (!s.due_date || (s.meter_left != null && s.meter_left <= 0) || (s.est_days != null && s.est_days < (s.days_left ?? Infinity)));
  if (meterFirst) badge = `<b class="sm">${esc(fmtN(s.due_meter))}</b><span>${esc(asset.meter_unit || '')}</span>`;
  else if (s.due_date) {
    const d = dateObj(s.due_date);
    badge = `<b>${d.getDate()}</b><span>${esc(F_MON.format(d))}</span>`;
  } else if (s.due_meter != null) badge = `<b class="sm">${esc(fmtN(s.due_meter))}</b><span>${esc(asset.meter_unit || '')}</span>`;
  else badge = '<b>—</b>';
  return `<div class="due-row ${s.state}">
    <button type="button" class="due-main" data-action="maint:${showAsset ? 'open-asset' : 'edit-task'}" data-id="${esc(showAsset ? asset.id : task.id)}">
      <span class="due-date">${badge}</span>
      <span class="due-body">
        <span class="due-name">${showAsset ? `${esc(c.emoji)} ` : ''}${esc(task.name)}</span>
        ${showAsset ? `<span class="due-sub">${esc(asset.name)}</span>` : `<span class="due-sub">${esc(intervalText(task, asset.meter_unit, fmtFull))}</span>`}
        <span class="due-meta">${esc(dueText(s, asset))}</span>
      </span>
    </button>
    ${s.state === 'done' ? '' : `<button type="button" class="btn sm ${s.state === 'ok' ? 'ghost' : 'primary'}" data-action="maint:done" data-task="${esc(task.id)}">ทำแล้ว</button>`}
  </div>`;
}

function logRow(l, pending, { showAsset = true } = {}) {
  const a = assetOf(l.asset_id);
  const unit = a ? a.meter_unit : '';
  const sub = [
    fmtFull(l.done_date),
    showAsset && a ? a.name : '',
    l.meter != null ? `${fmtN(l.meter)} ${unit}` : '',
    l.provider,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<button type="button" class="pay-row" data-action="maint:edit-log" data-id="${esc(l.id)}">
    <span class="pay-emoji" aria-hidden="true">${KIND[l.kind]?.icon || '•'}</span>
    <span class="pay-body"><span class="pay-name">${esc(logTitle(l))}</span><span class="pay-meta">${esc(sub)}${l.note ? ` · ${esc(l.note)}` : ''}</span></span>
    <span class="pay-amt">${esc(baht(l.cost))}${pending ? ' <span title="รอส่งขึ้นเซิร์ฟเวอร์">⏳</span>' : ''}</span>
  </button>`;
}
// ---------- หน้า: ต้องทำ ----------
const sorter = (x, y) => x.s.sort - y.s.sort || x.task.name.localeCompare(y.task.name, 'th');

function warrantySoon(t) {
  return state.assets
    .filter((a) => a.active)
    .map((a) => ({ a, w: warrantyLeft(a, t) }))
    .filter((x) => x.w != null && x.w >= 0 && x.w <= Math.max(60, x.a.warranty_remind_days))
    .sort((x, y) => x.w - y.w);
}

const warrantyRow = ({ a, w }) => `<button type="button" class="due-row warranty" data-action="maint:open-asset" data-id="${esc(a.id)}">
  <span class="due-main"><span class="due-date"><b>${w}</b><span>วัน</span></span>
  <span class="due-body"><span class="due-name">${esc(catOf(a.category).emoji)} ${esc(a.name)}</span><span class="due-meta">${esc(warrantyText(a))}</span></span></span>
</button>`;

function viewHome() {
  const all = statuses();
  const overdue = all.filter((x) => x.s.state === 'overdue').sort(sorter);
  const soon = all.filter((x) => x.s.state === 'soon').sort(sorter);
  const next = all.filter((x) => x.s.state === 'ok' && x.s.sort <= 60).sort(sorter);
  const t = today();
  const warranty = warrantySoon(t);
  const pending = pendingIds();
  const recent = logList()
    .sort((a, b) => b.done_date.localeCompare(a.done_date) || b.updated_at - a.updated_at)
    .slice(0, 8);
  const yearCost = logList()
    .filter((l) => l.done_date.startsWith(t.slice(0, 4)))
    .reduce((s, l) => s + (l.cost || 0), 0);
  const section = (title, list, kind) =>
    list.length ? `<h2 class="sec ${kind}">${title} <span class="count">${list.length}</span></h2><div class="due-list">${list.map((x) => taskRow(x)).join('')}</div>` : '';
  return {
    tab: '',
    title: 'ดูแลอุปกรณ์',
    body: `
    <section class="month-card stat3" aria-label="สรุป">
      <div><span>เลยกำหนด</span><b class="${overdue.length ? 'bad' : ''}">${overdue.length}</b></div>
      <div><span>ใกล้ถึง</span><b>${soon.length}</b></div>
      <div><span>ค่าดูแลปีนี้</span><b class="money">${esc(baht(yearCost) || '฿0')}</b></div>
    </section>
    <div class="action-row">
      <button type="button" class="btn primary" data-action="maint:new-log">+ บันทึกการดูแล/ซ่อม</button>
      <button type="button" class="btn" data-action="maint:new-asset">+ เพิ่มอุปกรณ์</button>
    </div>
    ${
      !state.assets.length
        ? `<div class="hero">
            <p><b>เริ่มจากเพิ่มอุปกรณ์ที่ต้องดูแล</b> เช่น รถ แอร์ เครื่องกรองน้ำ ถังดับเพลิง — เลือกประเภทแล้วแอปจะแนะนำงานดูแลตามรอบให้</p>
            <p class="muted">รอบถัดไปนับจากครั้งล่าสุดที่ทำจริง กด "ทำแล้ว" เมื่อทำเสร็จ (บันทึกย้อนหลังได้)</p>
          </div>`
        : ''
    }
    ${section('เลยกำหนด', overdue, 'overdue')}
    ${section('ใกล้ถึง', soon, 'soon')}
    ${state.tasks.length && !overdue.length && !soon.length ? '<p class="all-clear">✓ ไม่มีงานค้างหรือใกล้ถึงกำหนด</p>' : ''}
    ${section('ถัดไป (ภายใน 60 วัน)', next, 'later')}
    ${warranty.length ? `<h2 class="sec soon">ประกันใกล้หมด <span class="count">${warranty.length}</span></h2><div class="due-list">${warranty.map(warrantyRow).join('')}</div>` : ''}
    ${recent.length ? `<h2 class="sec">บันทึกล่าสุด</h2><div class="pay-list">${recent.map((l) => logRow(l, pending.has(l.id))).join('')}</div><a class="more-link" href="#/maint/history">ดูประวัติทั้งหมด →</a>` : ''}`,
  };
}

// ---------- หน้า: อุปกรณ์ ----------
function assetCard(a, sts) {
  const c = catOf(a.category);
  const mine = sts.filter((x) => x.asset.id === a.id && x.task.active);
  const od = mine.filter((x) => x.s.state === 'overdue').length;
  const sn = mine.filter((x) => x.s.state === 'soon').length;
  const status = !a.active
    ? 'เลิกใช้แล้ว'
    : od
      ? `<span class="bad">เลยกำหนด ${od} งาน</span>`
      : sn
        ? `<span class="warn">ใกล้ถึง ${sn} งาน</span>`
        : mine.length
          ? `<span class="good">ปกติ · ${mine.length} งานดูแล</span>`
          : '<span class="muted">ยังไม่มีงานดูแล</span>';
  const cur = a.meter_unit ? meterNow(a, logList()) : null;
  const meta = [a.brand, a.model, a.location].filter(Boolean).join(' · ');
  return `<button type="button" class="bill-card${a.active ? '' : ' inactive'}" data-action="maint:open-asset" data-id="${esc(a.id)}">
    <span class="bc-emoji" aria-hidden="true">${esc(c.emoji)}</span>
    <span class="bc-body">
      <span class="bc-top"><b>${esc(a.name)}</b>${cur != null ? `<span class="bc-amt">${esc(fmtN(cur))} ${esc(a.meter_unit)}</span>` : ''}</span>
      ${meta ? `<span class="bc-meta">${esc(meta)}</span>` : ''}
      <span class="bc-status">${status}</span>
      ${a.warranty_until ? `<span class="bc-meta">${esc(warrantyText(a))}</span>` : ''}
    </span>
  </button>`;
}

function viewAssets() {
  const sts = statuses({ includeInactive: true });
  const active = state.assets.filter((a) => a.active);
  const inactive = state.assets.filter((a) => !a.active);
  const byName = (x, y) => x.name.localeCompare(y.name, 'th');
  const groups = state.categories
    .map((c) => [c, active.filter((a) => a.category === c.key).sort(byName)])
    .filter(([, list]) => list.length);
  const known = new Set(state.categories.map((c) => c.key));
  const orphan = active.filter((a) => !known.has(a.category));
  return {
    tab: 'assets',
    title: 'อุปกรณ์',
    actions: '<button type="button" class="btn primary sm" data-action="maint:new-asset">+ เพิ่ม</button>',
    body: `
    ${active.length ? '' : '<p class="empty">ยังไม่มีอุปกรณ์ — กด "+ เพิ่ม" เพื่อเริ่ม</p>'}
    ${groups.map(([c, list]) => `<h2 class="sec">${esc(c.emoji)} ${esc(c.label)} <span class="count">${list.length}</span></h2><div class="bill-list">${list.map((a) => assetCard(a, sts)).join('')}</div>`).join('')}
    ${orphan.length ? `<h2 class="sec">อื่น ๆ</h2><div class="bill-list">${orphan.map((a) => assetCard(a, sts)).join('')}</div>` : ''}
    ${inactive.length ? `<details class="stopped"><summary>เลิกใช้/ขายแล้ว (${inactive.length})</summary><div class="bill-list">${inactive.sort(byName).map((a) => assetCard(a, sts)).join('')}</div></details>` : ''}`,
  };
}

// ---------- หน้า: รายละเอียดอุปกรณ์ ----------
function viewAsset(id) {
  const a = assetOf(id);
  if (!a) return { title: 'ไม่พบอุปกรณ์', back: '#/maint/assets', body: '<p class="empty">อุปกรณ์นี้อาจถูกลบไปแล้ว</p>' };
  const c = catOf(a.category);
  const t = today();
  const logs = logList();
  const mine = statuses({ includeInactive: true }).filter((x) => x.asset.id === a.id);
  const order = { overdue: 0, soon: 1, ok: 2, done: 3 };
  mine.sort((x, y) => (x.task.active === y.task.active ? 0 : x.task.active ? -1 : 1) || order[x.s.state] - order[y.s.state] || x.s.sort - y.s.sort);
  const history = logs.filter((l) => l.asset_id === a.id).sort((x, y) => y.done_date.localeCompare(x.done_date) || y.updated_at - x.updated_at);
  const pending = pendingIds();
  const cur = a.meter_unit ? meterNow(a, logs) : null;
  const rate = a.meter_unit ? usageRate(a, logs, t) : null;
  const totalCost = history.reduce((s, l) => s + (l.cost || 0), 0);
  const info = [
    ['ประเภท', `${c.emoji} ${c.label}`],
    ['ที่ตั้ง', a.location],
    ['ยี่ห้อ/รุ่น', [a.brand, a.model].filter(Boolean).join(' ')],
    ['S/N / ทะเบียน', a.serial],
    ['วันที่ซื้อ', a.purchase_date ? fmtFull(a.purchase_date) : ''],
    ['ราคา', baht(a.price)],
    ['ประกัน', warrantyText(a)],
    ['ติดต่อ', a.contact],
  ].filter(([, v]) => v);
  return {
    title: `${esc(c.emoji)} ${esc(a.name)}`,
    back: '#/maint/assets',
    actions: `<button type="button" class="btn sm ghost" data-action="maint:edit-asset" data-id="${esc(a.id)}">แก้ไข</button>`,
    body: `
    ${a.active ? '' : '<p class="warn-box">อุปกรณ์นี้ถูกตั้งเป็น "เลิกใช้แล้ว" — ไม่มีการเตือน</p>'}
    <section class="card info-grid">
      ${info.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      ${a.notes ? `<div class="full"><span>หมายเหตุ</span><p class="details">${esc(a.notes)}</p></div>` : ''}
      ${history.length ? `<div class="full"><span>ค่าดูแล/ซ่อมรวม</span><b>${esc(baht(totalCost) || '฿0')} <small class="muted">(${history.length} บันทึก)</small></b></div>` : ''}
    </section>
    ${
      a.meter_unit
        ? `<section class="card meter-card">
            <div><span class="muted">${a.meter_unit === 'กม.' ? 'เลขไมล์ล่าสุด' : 'ชั่วโมงใช้งานล่าสุด'}</span>
              <b>${cur != null ? `${esc(fmtN(cur))} ${esc(a.meter_unit)}` : 'ยังไม่ได้จด'}</b>
              ${rate ? `<small class="muted">ใช้งานเฉลี่ย ~${esc(fmtN(rate * 30))} ${esc(a.meter_unit)}/เดือน</small>` : ''}</div>
            <button type="button" class="btn sm" data-action="maint:new-reading" data-id="${esc(a.id)}">อัปเดต${a.meter_unit === 'กม.' ? 'เลขไมล์' : 'ชั่วโมง'}</button>
          </section>`
        : ''
    }
    <div class="sec-row"><h2 class="sec">งานดูแลตามรอบ <span class="count">${mine.length}</span></h2>
      <button type="button" class="btn sm ghost" data-action="maint:new-task" data-id="${esc(a.id)}">+ เพิ่มงาน</button></div>
    ${
      mine.length
        ? `<div class="due-list">${mine
            .map((x) => {
              const last = x.s.last;
              return `${taskRow(x, { showAsset: false })}${
                last ? `<p class="last-done">ทำล่าสุด ${esc(fmtFull(last.done_date))}${last.meter != null ? ` · ${esc(fmtN(last.meter))} ${esc(a.meter_unit)}` : ''}${last.cost != null ? ` · ${esc(baht(last.cost))}` : ''}</p>` : '<p class="last-done">ยังไม่เคยบันทึกว่าทำ — ถ้าเคยทำแล้ว กด "ทำแล้ว" แล้วใส่วันที่ทำครั้งล่าสุด</p>'
              }${x.task.active ? '' : '<p class="last-done">ปิดงานนี้ไว้ (ไม่เตือน)</p>'}`;
            })
            .join('')}</div>`
        : `<p class="empty">ยังไม่มีงานดูแล — กด "+ เพิ่มงาน"${TEMPLATES[a.category] ? ' (มีงานแนะนำสำหรับประเภทนี้)' : ''}</p>`
    }
    <div class="sec-row"><h2 class="sec">ประวัติ <span class="count">${history.length}</span></h2>
      <button type="button" class="btn sm ghost" data-action="maint:new-repair" data-id="${esc(a.id)}">+ บันทึกซ่อม/อื่น ๆ</button></div>
    ${history.length ? `<div class="pay-list">${history.map((l) => logRow(l, pending.has(l.id), { showAsset: false })).join('')}</div>` : '<p class="empty">ยังไม่มีบันทึก</p>'}`,
  };
}

// ---------- หน้า: ประวัติ ----------
function historyList() {
  const h = state.hist;
  const src = logList();
  if (h.q) {
    const q = h.q.toLowerCase();
    return src.filter((l) => {
      const a = assetOf(l.asset_id);
      return `${logTitle(l)} ${l.note} ${l.provider} ${a ? a.name : ''}`.toLowerCase().includes(q);
    });
  }
  return src.filter((l) => monthOf(l.done_date) === h.month);
}

function viewHistory() {
  const h = state.hist;
  const list = historyList().sort((a, b) => b.done_date.localeCompare(a.done_date) || b.updated_at - a.updated_at);
  const total = list.reduce((s, l) => s + (l.cost || 0), 0);
  const byAsset = new Map();
  for (const l of list) if (l.cost) byAsset.set(l.asset_id, (byAsset.get(l.asset_id) || 0) + l.cost);
  const top = [...byAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = top.length ? top[0][1] : 0;
  const pending = pendingIds();
  const groups = new Map();
  for (const l of list) {
    if (!groups.has(l.done_date)) groups.set(l.done_date, []);
    groups.get(l.done_date).push(l);
  }
  const isCurrent = h.month >= monthOf(today());
  const searchFocused = document.activeElement && document.activeElement.id === 'maint-q';
  return {
    tab: 'history',
    title: 'ประวัติการดูแล',
    body: `
    <input class="in search" id="maint-q" type="search" placeholder="ค้นหา เช่น ล้างแอร์, เปลี่ยนยาง, ชื่อร้าน" value="${esc(h.q)}" autocomplete="off">
    ${
      h.q
        ? `<p class="range-label">ผลการค้นหา "${esc(h.q)}" · ${list.length} รายการ</p>`
        : `<div class="month-nav">
            <button type="button" class="icon-btn" data-action="maint:hist-prev" aria-label="เดือนก่อน">${ICON.prev}</button>
            <b>${esc(monthLabel(h.month))}</b>
            <button type="button" class="icon-btn" data-action="maint:hist-next" aria-label="เดือนถัดไป" ${isCurrent ? 'disabled' : ''}>${ICON.next}</button>
          </div>`
    }
    <section class="month-card">
      <div class="mc-grid">
        <div><span>${h.q ? 'ค่าใช้จ่ายที่พบ' : 'ค่าใช้จ่ายเดือนนี้'}</span><b>${esc(baht(total) || '฿0')}</b><small>${list.length} บันทึก</small></div>
        <div class="cat-bars">${top
          .map(([id, v]) => {
            const a = assetOf(id);
            return `<div class="cb"><span>${esc(a ? `${catOf(a.category).emoji} ${a.name}` : '—')}</span><i><em data-w="${max ? Math.max(4, Math.round((v / max) * 100)) : 0}"></em></i><b>${esc(baht(v))}</b></div>`;
          })
          .join('')}</div>
      </div>
    </section>
    ${
      list.length
        ? [...groups.entries()]
            .map(([d, ls]) => `<h2 class="day-head">${esc(F_WD.format(dateObj(d)))} ${esc(String(dateObj(d).getFullYear() + 543))}</h2><div class="pay-list">${ls.map((l) => logRow(l, pending.has(l.id))).join('')}</div>`)
            .join('')
        : `<p class="empty">${h.q ? 'ไม่พบรายการ' : 'ไม่มีบันทึกในเดือนนี้'}</p>`
    }
    <div class="row no-print">
      <button type="button" class="btn ghost" data-action="maint:hist-csv" ${list.length ? '' : 'disabled'}>ดาวน์โหลด CSV ${h.q ? 'ผลการค้นหา' : 'เดือนนี้'}</button>
    </div>`,
    after() {
      for (const em of $$('.cat-bars em')) em.style.width = `${em.dataset.w}%`;
      if (searchFocused) {
        const q = $('#maint-q');
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      }
    },
  };
}

function view(path) {
  const [p, id] = path.split('/');
  if (p === 'assets') return viewAssets();
  if (p === 'asset' && id) return viewAsset(id);
  if (p === 'history') return viewHistory();
  return viewHome();
}

// ---------- หน้า "วันนี้" ----------
function todayCard() {
  const all = statuses();
  const due = all.filter((x) => x.s.state === 'overdue' || x.s.state === 'soon').sort(sorter);
  const warranty = warrantySoon(today()).filter((x) => x.w <= x.a.warranty_remind_days);
  if (!due.length && !warranty.length) return '';
  return `<div class="due-list">${due
    .slice(0, 5)
    .map((x) => taskRow(x))
    .join('')}${warranty.slice(0, 3).map(warrantyRow).join('')}</div>${due.length > 5 ? `<a class="more-link" href="#/maint">ดูอีก ${due.length - 5} งาน →</a>` : ''}`;
}

// ---------- แผ่น (bottom sheet) ----------
let mode = null; // 'asset' | 'task' | 'log'
let A = null;
let K = null;
let L = null;

const val = (id) => {
  const el = $(id, sheetEl);
  return el ? el.value.trim() : '';
};

// ----- อุปกรณ์ -----
function openAsset(asset) {
  mode = 'asset';
  A = asset
    ? { ...asset, isNew: false }
    : {
        id: uuid(),
        name: '',
        category: 'other',
        location: '',
        brand: '',
        model: '',
        serial: '',
        purchase_date: null,
        price: null,
        warranty_until: null,
        warranty_remind_days: 30,
        contact: '',
        notes: '',
        meter_unit: '',
        meter_start: null,
        active: true,
        isNew: true,
        picks: new Set(),
      };
  renderAssetSheet();
}

function setAssetCategory(key) {
  A.category = key;
  const tpl = TEMPLATES[key];
  if (A.isNew) {
    A.picks = new Set(tpl ? tpl.tasks.map((t, i) => (t[4] ? i : -1)).filter((i) => i >= 0) : []);
    if (tpl && tpl.meter && !A.meter_unit) A.meter_unit = tpl.meter;
  }
}

function readAssetForm() {
  A.name = val('#a-name');
  A.location = val('#a-location');
  A.brand = val('#a-brand');
  A.model = val('#a-model');
  A.serial = val('#a-serial');
  A.purchase_date = val('#a-purchase') || null;
  A.price = parseNum(val('#a-price'));
  A.warranty_until = val('#a-warranty') || null;
  A.contact = val('#a-contact');
  A.notes = val('#a-notes');
  const ms = $('#a-meter', sheetEl);
  if (ms) A.meter_start = parseNum(ms.value);
  const act = $('#a-active', sheetEl);
  if (act) A.active = act.checked;
}

function renderAssetSheet() {
  const a = A;
  const tpl = a.isNew ? TEMPLATES[a.category] : null;
  const cats = state.categories.filter((c) => !c.hidden || c.key === a.category);
  openSheet(`
    <form class="sheet-body" id="asset-form" novalidate>
      ${sheetHead(a.isNew ? 'เพิ่มอุปกรณ์' : 'แก้ไขอุปกรณ์')}
      <div class="field"><span class="label">ประเภท</span>
        <div class="chips">${cats.map((c) => `<button type="button" class="chip${a.category === c.key ? ' on' : ''}" data-x="a-cat" data-v="${esc(c.key)}">${esc(c.emoji)} ${esc(c.label)}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="a-name">ชื่อ *</label>
        <input id="a-name" maxlength="120" value="${esc(a.name)}" placeholder="เช่น แอร์ห้องนอน, Honda City, เครื่องกรองน้ำครัว" autocomplete="off"></div>
      <div class="field"><label for="a-location">ที่ตั้ง/ห้อง</label><input id="a-location" maxlength="80" value="${esc(a.location)}" placeholder="เช่น ห้องนอนใหญ่, บ้านแม่"></div>
      <div class="field two">
        <div><label for="a-brand">ยี่ห้อ</label><input id="a-brand" class="in" maxlength="80" value="${esc(a.brand)}"></div>
        <div><label for="a-model">รุ่น</label><input id="a-model" class="in" maxlength="80" value="${esc(a.model)}"></div>
      </div>
      <div class="field"><label for="a-serial">S/N / ทะเบียน</label><input id="a-serial" maxlength="80" value="${esc(a.serial)}"></div>
      <div class="field two">
        <div><label for="a-purchase">วันที่ซื้อ</label><input id="a-purchase" class="in" type="date" value="${esc(a.purchase_date || '')}"></div>
        <div><label for="a-price">ราคา (บาท)</label><input id="a-price" class="in" inputmode="decimal" value="${a.price ?? ''}"></div>
      </div>
      <div class="field"><label for="a-warranty">ประกันถึงวันที่</label><input id="a-warranty" type="date" value="${esc(a.warranty_until || '')}">
        <div class="chips">${[0, 7, 30, 60]
          .map((d) => `<button type="button" class="chip soft${a.warranty_remind_days === d ? ' on' : ''}" data-x="a-wr" data-v="${d}">${d ? `เตือน ${d} วันก่อน` : 'ไม่เตือน'}</button>`)
          .join('')}</div></div>
      <div class="field"><span class="label">มีเลขไมล์/ชั่วโมงใช้งานไหม</span>
        <div class="chips">${[
          ['', 'ไม่มี'],
          ['กม.', 'เลขไมล์ (กม.)'],
          ['ชม.', 'ชั่วโมงใช้งาน'],
        ]
          .map(([v, l]) => `<button type="button" class="chip${a.meter_unit === v ? ' on' : ''}" data-x="a-mu" data-v="${v}">${l}</button>`)
          .join('')}</div>
        ${a.meter_unit && a.isNew ? `<input id="a-meter" class="in mt" inputmode="decimal" value="${a.meter_start ?? ''}" placeholder="ตอนนี้กี่ ${esc(a.meter_unit)}">` : ''}
      </div>
      <div class="field"><label for="a-contact">ช่าง/ร้าน/ศูนย์บริการที่ติดต่อ</label><input id="a-contact" maxlength="300" value="${esc(a.contact)}" placeholder="เช่น ร้านแอร์ช่างเอ 08x-xxx-xxxx"></div>
      <div class="field"><label for="a-notes">หมายเหตุ</label><textarea id="a-notes" rows="2" maxlength="2000" placeholder="เช่น ขนาดไส้กรอง, เบอร์ยาง, รหัสอะไหล่">${esc(a.notes)}</textarea></div>
      ${
        tpl
          ? `<div class="field"><span class="label">งานดูแลแนะนำ <small>(แก้ไขได้ภายหลัง)</small></span>
              <div class="tpl-list">${tpl.tasks
                .map(
                  ([name, every, unit, km], i) => `<label class="check tpl"><input type="checkbox" data-x="a-pick" value="${i}" ${a.picks.has(i) ? 'checked' : ''}>
                    <span><b>${esc(name)}</b> <span class="muted">${esc(intervalText({ unit, every, every_meter: km }, tpl.meter || a.meter_unit, fmtFull))}</span></span></label>`
                )
                .join('')}</div>
              <p class="hint">รอบแรกจะนับจากวันนี้ ถ้าเคยทำแล้วไปกด "ทำแล้ว" ในหน้าอุปกรณ์ แล้วใส่วันที่ทำครั้งล่าสุด</p></div>`
          : ''
      }
      ${a.isNew ? '' : `<label class="check big"><input type="checkbox" id="a-active" ${a.active ? 'checked' : ''}> ยังใช้งานอยู่ <span class="muted">(เอาออก = เลิกใช้/ขายแล้ว ไม่เตือน)</span></label>`}
      <div class="sheet-actions">
        ${a.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="a-del">ลบ</button>'}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
}

async function submitAsset() {
  readAssetForm();
  if (!A.name) return toast('กรุณาใส่ชื่ออุปกรณ์');
  if (Number.isNaN(A.price) || Number.isNaN(A.meter_start)) return toast('ตัวเลขไม่ถูกต้อง');
  const { isNew, picks, ...asset } = A;
  try {
    const r = await api(`/api/maint/assets/${encodeURIComponent(asset.id)}`, { method: 'PUT', body: { asset } });
    const i = state.assets.findIndex((x) => x.id === asset.id);
    if (i >= 0) state.assets[i] = r.asset;
    else state.assets.push(r.asset);
    let made = 0;
    const tpl = isNew ? TEMPLATES[asset.category] : null;
    if (tpl && picks && picks.size) {
      const t = today();
      for (const idx of picks) {
        const [name, every, unit, km] = tpl.tasks[idx];
        const task = {
          id: uuid(),
          asset_id: asset.id,
          name,
          unit,
          every,
          every_meter: r.asset.meter_unit ? km : null,
          first_due: addInterval(t, every, unit),
          first_due_meter: r.asset.meter_unit && km && r.asset.meter_start != null ? r.asset.meter_start + km : null,
          remind_days: unit === 'month' && every === 1 ? 3 : 7,
          active: true,
        };
        const tr = await api(`/api/maint/tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', body: { task } });
        state.tasks.push(tr.task);
        made++;
      }
    }
    saveCache();
    closeSheet();
    toast(isNew ? `เพิ่ม ${r.asset.name} แล้ว${made ? ` พร้อมงานดูแล ${made} งาน` : ''}` : 'บันทึกแล้ว');
    if (isNew) location.hash = `#/maint/asset/${encodeURIComponent(asset.id)}`;
    else rerender();
  } catch (e) {
    if (!handleErr(e)) toast(`บันทึกไม่สำเร็จ (${e.code || e.message})`);
    else if (e.network) toast('ต้องต่ออินเทอร์เน็ตเพื่อเพิ่ม/แก้อุปกรณ์');
  }
}

// ----- งานดูแล -----
function openTask(task, assetId) {
  mode = 'task';
  const a = assetOf(task ? task.asset_id : assetId);
  if (!a) return;
  const t = today();
  K = task
    ? { ...task, isNew: false }
    : { id: uuid(), asset_id: a.id, name: '', unit: 'month', every: 6, every_meter: null, first_due: addInterval(t, 6, 'month'), first_due_meter: null, remind_days: 7, est_cost: null, notes: '', active: true, isNew: true };
  K.custom = !FREQS.some(([u, e]) => u === K.unit && (u === 'once' || e === K.every));
  K.dueTouched = !K.isNew;
  renderTaskSheet();
}

function readTaskForm() {
  K.name = val('#k-name');
  if (K.custom && K.unit !== 'once' && K.unit !== '') {
    K.every = Math.max(1, parseInt(val('#k-every'), 10) || 1);
    K.unit = $('#k-unit', sheetEl).value;
  }
  const km = $('#k-km', sheetEl);
  K.every_meter = km ? parseNum(km.value) : null;
  K.first_due = val('#k-first') || null;
  const fm = $('#k-firstm', sheetEl);
  K.first_due_meter = fm ? parseNum(fm.value) : null;
  K.est_cost = parseNum(val('#k-cost'));
  K.notes = val('#k-notes');
  const act = $('#k-active', sheetEl);
  if (act) K.active = act.checked;
}

function taskPreview() {
  const a = assetOf(K.asset_id);
  const s = taskStatus({ ...K, every_meter: Number.isNaN(K.every_meter) ? null : K.every_meter }, a, logList(), today());
  const bits = [];
  if (s.due_date) bits.push(fmtFull(s.due_date));
  if (s.due_meter != null) bits.push(`${fmtN(s.due_meter)} ${a.meter_unit}`);
  if (s.state === 'done') return 'งานครั้งเดียวนี้ทำแล้ว';
  return bits.length ? `ครั้งถัดไป: ${bits.join(' หรือ ')}${s.last ? ` (นับจากที่ทำล่าสุด ${fmtFull(s.last.done_date)})` : ''}` : 'ยังคำนวณครั้งถัดไปไม่ได้';
}

function renderTaskSheet() {
  const k = K;
  const a = assetOf(k.asset_id);
  const tpl = k.isNew ? TEMPLATES[a.category] : null;
  const hasLog = logList().some((l) => l.task_id === k.id && l.kind === 'done');
  openSheet(`
    <form class="sheet-body" id="task-form" novalidate>
      ${sheetHead(`${k.isNew ? 'เพิ่มงานดูแล' : 'แก้ไขงานดูแล'} · ${esc(a.name)}`)}
      <div class="field"><label for="k-name">งาน *</label>
        <input id="k-name" maxlength="120" value="${esc(k.name)}" placeholder="เช่น ล้างแอร์, เปลี่ยนไส้กรอง" autocomplete="off">
        ${tpl ? `<div class="chips">${tpl.tasks.map(([n], i) => `<button type="button" class="chip soft" data-x="k-tpl" data-v="${i}">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><span class="label">ทำทุก ๆ</span>
        <div class="chips">${FREQS.map(
          ([u, e, label]) => `<button type="button" class="chip${!k.custom && k.unit === u && (u === 'once' || k.every === e) ? ' on' : ''}" data-x="k-freq" data-u="${u}" data-e="${e ?? ''}">${label}</button>`
        ).join('')}<button type="button" class="chip${k.custom && k.unit !== '' ? ' on' : ''}" data-x="k-custom">กำหนดเอง</button>${
          a.meter_unit ? `<button type="button" class="chip${k.unit === '' ? ' on' : ''}" data-x="k-meteronly">ตาม${a.meter_unit === 'กม.' ? 'เลขไมล์' : 'ชั่วโมง'}อย่างเดียว</button>` : ''
        }</div>
        ${
          k.custom && k.unit !== '' && k.unit !== 'once'
            ? `<div class="custom-freq">ทุก <input id="k-every" class="in" type="number" min="1" max="1000" value="${esc(k.every ?? 1)}">
                <select id="k-unit" class="in">${Object.entries(UNIT_TH).map(([u, l]) => `<option value="${u}" ${k.unit === u ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`
            : ''
        }
        ${
          a.meter_unit && k.unit !== 'once'
            ? `<div class="custom-freq">${k.unit === '' ? 'ทุก' : 'หรือทุก'} <input id="k-km" class="in wide" inputmode="decimal" value="${k.every_meter ?? ''}" placeholder="เช่น 10000"> ${esc(a.meter_unit)} <span class="muted">${k.unit === '' ? '' : '(อย่างไหนถึงก่อน)'}</span></div>`
            : ''
        }
      </div>
      ${
        hasLog && k.unit !== 'once'
          ? ''
          : `<div class="field two">
              ${k.unit === '' ? '' : `<div><label for="k-first">${k.unit === 'once' ? 'ต้องทำภายในวันที่' : 'ครบกำหนดครั้งแรก'}</label><input id="k-first" class="in" type="date" value="${esc(k.first_due || '')}"></div>`}
              ${a.meter_unit && k.unit !== 'once' ? `<div><label for="k-firstm">หรือที่ ${esc(a.meter_unit)}</label><input id="k-firstm" class="in" inputmode="decimal" value="${k.first_due_meter ?? ''}"></div>` : ''}
            </div>
            ${k.unit !== 'once' ? '<p class="hint">ใช้เฉพาะตอนยังไม่เคยบันทึกว่าทำ — หลังจากนั้นรอบถัดไปจะนับจากครั้งล่าสุดที่ทำจริง</p>' : ''}`
      }
      <p class="preview" id="k-preview"></p>
      <div class="field"><span class="label">เตือนล่วงหน้า</span>
        <div class="chips">${[1, 3, 7, 14, 30].map((d) => `<button type="button" class="chip${k.remind_days === d ? ' on' : ''}" data-x="k-remind" data-v="${d}">${d} วัน</button>`).join('')}</div>
        ${a.meter_unit && k.unit !== 'once' ? `<p class="hint">ตามระยะ: เตือนเมื่อเหลือไม่ถึง 10% ของรอบ</p>` : ''}
      </div>
      <div class="field"><label for="k-cost">ค่าใช้จ่ายโดยประมาณ (บาท)</label><input id="k-cost" inputmode="decimal" value="${k.est_cost ?? ''}"></div>
      <div class="field"><label for="k-notes">หมายเหตุ</label><textarea id="k-notes" rows="2" maxlength="1000" placeholder="เช่น ใช้น้ำมัน 5W-30 4 ลิตร, ไส้กรองรุ่น ...">${esc(k.notes)}</textarea></div>
      ${k.isNew ? '' : `<label class="check big"><input type="checkbox" id="k-active" ${k.active ? 'checked' : ''}> ยังทำงานนี้อยู่ <span class="muted">(เอาออก = ไม่เตือน)</span></label>`}
      <div class="sheet-actions">
        ${k.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="k-del">ลบ</button>'}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
  $('#k-preview', sheetEl).textContent = taskPreview();
}

async function submitTask() {
  readTaskForm();
  if (!K.name) return toast('กรุณาใส่ชื่องาน');
  if ([K.every_meter, K.first_due_meter, K.est_cost].some(Number.isNaN)) return toast('ตัวเลขไม่ถูกต้อง');
  if (K.unit === '' && !K.every_meter) return toast('กรุณาใส่ระยะ เช่น ทุก 10000 กม.');
  if (K.unit === 'once' && !K.first_due) return toast('กรุณาใส่วันที่ต้องทำ');
  const { isNew, custom, dueTouched, ...task } = K;
  try {
    const r = await api(`/api/maint/tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', body: { task } });
    const i = state.tasks.findIndex((x) => x.id === task.id);
    if (i >= 0) state.tasks[i] = r.task;
    else state.tasks.push(r.task);
    saveCache();
    closeSheet();
    toast(isNew ? 'เพิ่มงานดูแลแล้ว' : 'บันทึกแล้ว');
    rerender();
  } catch (e) {
    const m = { every_required: 'กรุณาใส่รอบ', schedule_required: 'กรุณาตั้งรอบเวลาหรือระยะ', first_due_required: 'กรุณาใส่วันที่ต้องทำ' };
    if (!handleErr(e)) toast(m[e.code] || `บันทึกไม่สำเร็จ (${e.code || e.message})`);
    else if (e.network) toast('ต้องต่ออินเทอร์เน็ตเพื่อเพิ่ม/แก้งาน');
  }
}

// ----- บันทึก (ทำแล้ว / ซ่อม / เลขไมล์ / อื่น ๆ) -----
function openLog({ log, taskId, assetId, kind }) {
  mode = 'log';
  const t = today();
  if (log) L = { ...log, isNew: false };
  else {
    const task = taskId ? taskOf(taskId) : null;
    const aid = task ? task.asset_id : assetId || (state.assets.find((a) => a.active) || {}).id;
    const a = assetOf(aid);
    L = {
      id: uuid(),
      asset_id: aid || null,
      task_id: task ? task.id : null,
      kind: kind || (task ? 'done' : 'repair'),
      done_date: t,
      title: '',
      meter: a && a.meter_unit ? meterNow(a, logList()) : null,
      cost: task ? task.est_cost : null,
      provider: '',
      note: '',
      isNew: true,
    };
  }
  renderLogSheet();
}

function readLogForm() {
  const g = (id) => $(id, sheetEl);
  if (g('#l-title')) L.title = val('#l-title');
  if (g('#l-date')) L.done_date = val('#l-date');
  if (g('#l-meter')) L.meter = parseNum(val('#l-meter'));
  if (g('#l-cost')) L.cost = parseNum(val('#l-cost'));
  if (g('#l-provider')) L.provider = val('#l-provider');
  if (g('#l-note')) L.note = val('#l-note');
  if (g('#l-task')) L.task_id = g('#l-task').value || null;
}

function renderLogSheet() {
  const l = L;
  const a = l.asset_id ? assetOf(l.asset_id) : null;
  const t = today();
  const tasks = a ? state.tasks.filter((k) => k.asset_id === a.id && (k.active || k.id === l.task_id)) : [];
  const providers = [...new Set(logList().filter((x) => x.provider).sort((x, y) => y.updated_at - x.updated_at).map((x) => x.provider))].slice(0, 6);
  const task = l.task_id ? taskOf(l.task_id) : null;
  const title = l.isNew ? (l.kind === 'done' && task ? `${esc(task.name)}` : l.kind === 'reading' ? 'อัปเดตเลขไมล์' : 'บันทึก') : 'แก้ไขบันทึก';
  const activeAssets = state.assets.filter((x) => x.active || x.id === l.asset_id);
  openSheet(`
    <form class="sheet-body" id="log-form" novalidate>
      ${sheetHead(title)}
      ${
        l.isNew && !(l.kind === 'done' && task)
          ? `<div class="field"><span class="label">อุปกรณ์</span>
              <div class="chips">${activeAssets
                .map((x) => `<button type="button" class="chip${x.id === l.asset_id ? ' on' : ''}" data-x="l-asset" data-v="${esc(x.id)}">${esc(catOf(x.category).emoji)} ${esc(x.name)}</button>`)
                .join('')}</div>
              ${activeAssets.length ? '' : '<p class="hint">ยังไม่มีอุปกรณ์ — เพิ่มอุปกรณ์ก่อน</p>'}
            </div>
            <div class="field"><span class="label">บันทึกอะไร</span>
              <div class="chips">${Object.entries(KIND)
                .filter(([k]) => k !== 'reading' || (a && a.meter_unit))
                .map(([k, v]) => `<button type="button" class="chip${l.kind === k ? ' on' : ''}" data-x="l-kind" data-v="${k}">${v.icon} ${v.label}</button>`)
                .join('')}</div></div>`
          : `<div class="info-box"><div><b>${esc(a ? `${catOf(a.category).emoji} ${a.name}` : 'อุปกรณ์ถูกลบแล้ว')}</b> · ${esc(KIND[l.kind]?.label || '')}</div>
              ${task && task.notes ? `<div class="details">${esc(task.notes)}</div>` : ''}</div>`
      }
      ${
        l.kind === 'done' && a
          ? `<div class="field"><label for="l-task">งานที่ทำ</label>
              <select id="l-task" class="in">${tasks.map((k) => `<option value="${esc(k.id)}" ${k.id === l.task_id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}${
                tasks.length ? '' : '<option value="">— ยังไม่มีงานดูแล —</option>'
              }</select></div>`
          : ''
      }
      ${l.kind === 'repair' || l.kind === 'note' ? `<div class="field"><label for="l-title">ทำอะไร *</label><input id="l-title" maxlength="160" value="${esc(l.title)}" placeholder="${l.kind === 'repair' ? 'เช่น เปลี่ยนคาปาซิเตอร์, ซ่อมท่อรั่ว' : 'เช่น ได้ยินเสียงดัง, ตรวจสภาพ'}" autocomplete="off"></div>` : ''}
      <div class="field"><label for="l-date">วันที่</label>
        <input id="l-date" type="date" value="${esc(l.done_date)}" max="${esc(addDays(t, 1))}">
        <div class="chips"><button type="button" class="chip soft" data-x="l-date" data-v="${t}">วันนี้</button><button type="button" class="chip soft" data-x="l-date" data-v="${addDays(t, -1)}">เมื่อวาน</button></div>
      </div>
      ${a && a.meter_unit ? `<div class="field"><label for="l-meter">${a.meter_unit === 'กม.' ? 'เลขไมล์' : 'ชั่วโมงใช้งาน'} (${esc(a.meter_unit)})</label><input id="l-meter" inputmode="decimal" value="${l.meter ?? ''}"></div>` : ''}
      ${
        l.kind === 'reading'
          ? ''
          : `<div class="field two">
              <div><label for="l-cost">ค่าใช้จ่าย (บาท)</label><input id="l-cost" class="in" inputmode="decimal" value="${l.cost ?? ''}"></div>
              <div><label for="l-provider">ทำโดย/ร้าน</label><input id="l-provider" class="in" maxlength="120" value="${esc(l.provider)}" placeholder="ทำเอง" list="dl-prov"></div>
            </div>
            <datalist id="dl-prov">${['ทำเอง', ...providers].map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
            <div class="field"><label for="l-note">หมายเหตุ</label><textarea id="l-note" rows="2" maxlength="2000" placeholder="เช่น เปลี่ยนอะไหล่อะไร, รับประกันงานซ่อมกี่เดือน">${esc(l.note)}</textarea></div>`
      }
      <div class="sheet-actions">
        ${l.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="l-del">ลบ</button>'}
        <button type="submit" class="btn primary">${l.isNew && l.kind === 'done' ? '✓ บันทึกว่าทำแล้ว' : 'บันทึก'}</button>
      </div>
    </form>`);
}

function submitLog() {
  readLogForm();
  if (!L.asset_id) return toast('กรุณาเลือกอุปกรณ์');
  if (L.kind === 'done' && !L.task_id) return toast('อุปกรณ์นี้ยังไม่มีงานดูแล — เลือก "ซ่อม" หรือเพิ่มงานก่อน');
  if ((L.kind === 'repair' || L.kind === 'note') && !L.title) return toast('กรุณาใส่ว่าทำอะไร');
  if (L.kind === 'reading' && L.meter == null) return toast('กรุณาใส่เลขไมล์');
  if (Number.isNaN(L.meter) || Number.isNaN(L.cost)) return toast('ตัวเลขไม่ถูกต้อง');
  if (!L.done_date) return toast('กรุณาใส่วันที่');
  if (L.kind === 'done' && !L.title) L.title = taskOf(L.task_id)?.name || '';
  const a = assetOf(L.asset_id);
  const cur = a && a.meter_unit ? meterNow(a, logList().filter((x) => x.id !== L.id)) : null;
  if (L.isNew && L.meter != null && cur != null && L.meter < cur && L.done_date >= today() && !confirm(`เลข ${fmtN(L.meter)} น้อยกว่าล่าสุด (${fmtN(cur)}) — บันทึกต่อไหม?`)) return;
  const wasNew = L.isNew;
  const saved = saveLog(L);
  closeSheet();
  toast(wasNew ? `บันทึกแล้ว: ${logTitle(saved) || 'เลขไมล์'}` : 'แก้ไขแล้ว', wasNew ? { label: 'เลิกทำ', fn: () => deleteLog(saved.id, { silent: true }) } : undefined);
}
// ----- events ของแผ่น -----
async function sheetClick(ev, b, x) {
  const toggleOn = (sel, v) => {
    for (const c of $$(sel, sheetEl)) c.classList.toggle('on', c.dataset.v === v);
  };

  if (mode === 'asset' && A) {
    if (x === 'a-cat') {
      readAssetForm();
      setAssetCategory(b.dataset.v);
      renderAssetSheet();
    } else if (x === 'a-mu') {
      readAssetForm();
      A.meter_unit = b.dataset.v;
      renderAssetSheet();
    } else if (x === 'a-wr') {
      A.warranty_remind_days = Number(b.dataset.v);
      toggleOn('[data-x="a-wr"]', b.dataset.v);
    } else if (x === 'a-pick') {
      b.checked ? A.picks.add(Number(b.value)) : A.picks.delete(Number(b.value));
    } else if (x === 'a-del') {
      if (!confirm(`ลบ "${A.name}" พร้อมงานดูแลและประวัติทั้งหมด? (ถ้าแค่เลิกใช้ ให้เอาเครื่องหมาย "ยังใช้งานอยู่" ออกแทน)`)) return;
      try {
        await api(`/api/maint/assets/${encodeURIComponent(A.id)}`, { method: 'DELETE' });
        const id = A.id;
        state.assets = state.assets.filter((y) => y.id !== id);
        state.tasks = state.tasks.filter((y) => y.asset_id !== id);
        for (const l of logList()) if (l.asset_id === id) state.logs.delete(l.id);
        saveCache();
        closeSheet();
        toast('ลบแล้ว');
        location.hash = '#/maint/assets';
      } catch (e) {
        if (!handleErr(e)) toast('ลบไม่สำเร็จ');
      }
    }
  } else if (mode === 'task' && K) {
    if (x === 'k-tpl') {
      readTaskForm();
      const a = assetOf(K.asset_id);
      const [name, every, unit, km] = TEMPLATES[a.category].tasks[Number(b.dataset.v)];
      Object.assign(K, { name, every, unit, every_meter: a.meter_unit ? km : null, custom: false, first_due: addInterval(today(), every, unit) });
      const cur = meterNow(a, logList());
      K.first_due_meter = a.meter_unit && km && cur != null ? cur + km : null;
      renderTaskSheet();
    } else if (x === 'k-freq') {
      readTaskForm();
      const unit = b.dataset.u;
      const every = b.dataset.e ? Number(b.dataset.e) : null;
      Object.assign(K, { unit, every, custom: false });
      if (K.isNew) K.first_due = unit === 'once' ? today() : addInterval(today(), every, unit);
      renderTaskSheet();
    } else if (x === 'k-custom') {
      readTaskForm();
      K.custom = true;
      if (K.unit === 'once' || K.unit === '') Object.assign(K, { unit: 'month', every: K.every || 1 });
      renderTaskSheet();
    } else if (x === 'k-meteronly') {
      readTaskForm();
      Object.assign(K, { unit: '', every: null, custom: true, first_due: null });
      renderTaskSheet();
    } else if (x === 'k-remind') {
      K.remind_days = Number(b.dataset.v);
      toggleOn('[data-x="k-remind"]', b.dataset.v);
    } else if (x === 'k-del') {
      if (!confirm(`ลบงาน "${K.name}"? (ประวัติที่บันทึกไว้ยังอยู่)`)) return;
      try {
        await api(`/api/maint/tasks/${encodeURIComponent(K.id)}`, { method: 'DELETE' });
        state.tasks = state.tasks.filter((y) => y.id !== K.id);
        saveCache();
        closeSheet();
        toast('ลบงานแล้ว');
        rerender();
      } catch (e) {
        if (!handleErr(e)) toast('ลบไม่สำเร็จ');
      }
    }
  } else if (mode === 'log' && L) {
    if (x === 'l-asset') {
      readLogForm();
      L.asset_id = b.dataset.v;
      const a = assetOf(L.asset_id);
      L.meter = a && a.meter_unit ? meterNow(a, logList()) : null;
      L.task_id = null;
      if (L.kind === 'reading' && !(a && a.meter_unit)) L.kind = 'repair';
      if (L.kind === 'done') L.task_id = (state.tasks.find((k) => k.asset_id === L.asset_id && k.active) || {}).id || null;
      renderLogSheet();
    } else if (x === 'l-kind') {
      readLogForm();
      L.kind = b.dataset.v;
      if (L.kind === 'done' && !L.task_id) L.task_id = (state.tasks.find((k) => k.asset_id === L.asset_id && k.active) || {}).id || null;
      if (L.kind !== 'done') L.task_id = null;
      renderLogSheet();
    } else if (x === 'l-date') {
      $('#l-date', sheetEl).value = b.dataset.v;
    } else if (x === 'l-del') {
      const id = L.id;
      closeSheet();
      deleteLog(id);
    }
  }
}

const sheet = {
  click: sheetClick,
  input() {
    if (mode === 'task' && K) {
      readTaskForm();
      const pv = $('#k-preview', sheetEl);
      if (pv) pv.textContent = taskPreview();
    }
  },
  change(ev) {
    if (mode === 'task' && K && ev.target.id === 'k-unit') {
      readTaskForm();
      const pv = $('#k-preview', sheetEl);
      if (pv) pv.textContent = taskPreview();
    }
  },
  submit(ev) {
    if (ev.target.id === 'asset-form' && A) submitAsset();
    else if (ev.target.id === 'task-form' && K) submitTask();
    else if (ev.target.id === 'log-form' && L) submitLog();
  },
  closed() {
    mode = A = K = L = null;
  },
};
// ---------- ตั้งค่า / สำรอง ----------
const cats = new CatEditor({ mod: ID, path: '/categories', noun: 'ประเภท' });

function settings() {
  return `<h3>ประเภทอุปกรณ์</h3>
    <p class="hint">แก้ไอคอน ชื่อ ลำดับ หรือซ่อนประเภทที่ไม่ใช้ (งานแนะนำมีเฉพาะประเภทเริ่มต้น)</p>
    ${cats.html(state.categories)}
    <div class="row"><button type="button" class="btn ghost" data-action="maint:export-csv">ส่งออกประวัติการดูแลทั้งหมด (CSV)</button></div>`;
}

async function exportData() {
  return api('/api/maint/data');
}

async function importData(data) {
  const assets = Array.isArray(data && data.assets) ? data.assets : [];
  const tasks = Array.isArray(data && data.tasks) ? data.tasks : [];
  const logs = Array.isArray(data && data.logs) ? data.logs : [];
  if (!assets.length && !logs.length) return '';
  if (!confirm(`ดูแลอุปกรณ์: นำเข้าอุปกรณ์ ${assets.length} รายการ งาน ${tasks.length} งาน และบันทึก ${logs.length} รายการ? (id ซ้ำจะถูกแทนถ้าไฟล์ใหม่กว่า)`)) return '';
  for (const asset of assets) await api(`/api/maint/assets/${encodeURIComponent(asset.id)}`, { method: 'PUT', body: { asset } });
  for (const task of tasks) await api(`/api/maint/tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', body: { task } });
  let rejected = 0;
  for (let i = 0; i < logs.length; i += 200) {
    const r = await api('/api/sync', { method: 'POST', body: { ops: logs.slice(i, i + 200).map((item) => ({ mod: ID, type: 'put', item })) } });
    rejected += r.rejected.length;
  }
  if (Array.isArray(data.categories) && confirm('ในไฟล์มีประเภทอุปกรณ์ด้วย ต้องการใช้จากไฟล์ไหม?')) {
    await api('/api/maint/categories', { method: 'PUT', body: { categories: data.categories } });
    cats.edit = null;
  }
  return `อุปกรณ์ ${assets.length} · บันทึก ${logs.length - rejected}${rejected ? ` (ข้าม ${rejected})` : ''}`;
}

// ---------- actions ----------
const actions = {
  'open-asset': (b) => go(`#/maint/asset/${encodeURIComponent(b.dataset.id)}`),
  'new-asset': () => openAsset(null),
  'edit-asset': (b) => openAsset(assetOf(b.dataset.id)),
  'new-task': (b) => openTask(null, b.dataset.id),
  'edit-task': (b) => openTask(taskOf(b.dataset.id)),
  done: (b) => openLog({ taskId: b.dataset.task }),
  'new-log': () => openLog({}),
  'new-repair': (b) => openLog({ assetId: b.dataset.id, kind: 'repair' }),
  'new-reading': (b) => openLog({ assetId: b.dataset.id, kind: 'reading' }),
  'edit-log': (b) => {
    const l = state.logs.get(b.dataset.id);
    if (l) openLog({ log: l });
  },
  'hist-prev': () => {
    state.hist.month = monthOf(addMonths(`${state.hist.month}-01`, -1));
    rerender();
  },
  'hist-next': () => {
    state.hist.month = monthOf(addMonths(`${state.hist.month}-01`, 1));
    rerender();
  },
  'hist-csv': () => {
    const h = state.hist;
    download(h.q ? 'maintenance_search.csv' : `maintenance_${h.month}.csv`, toCSV(historyList()), 'text/csv;charset=utf-8');
  },
  'export-csv': () => download(`maintenance_all_${today()}.csv`, toCSV(logList()), 'text/csv;charset=utf-8'),
};
for (const name of ['cat-add', 'cat-up', 'cat-down', 'cat-save', 'cat-reset']) {
  actions[name] = (b) =>
    cats.handle(name, b, {
      api,
      toast,
      handleErr,
      saved: (c) => {
        state.categories = c;
        saveCache();
        rerender();
      },
    });
}

let searchTimer;
const mod = {
  id: ID,
  label: 'ดูแลอุปกรณ์',
  short: 'อุปกรณ์',
  emoji: '🔧',
  icon: 'wrench',
  about: 'รอบดูแลตามเวลา/เลขไมล์ ประวัติซ่อม ประกัน',
  tabs: [
    ['', 'ต้องทำ'],
    ['assets', 'อุปกรณ์'],
    ['history', 'ประวัติ'],
  ],
  quick: [{ label: 'บันทึกการดูแล', action: 'maint:new-log' }],
  init(c) {
    ctx = c;
    sheetEl = c.sheetEl;
  },
  refresh,
  view,
  today: todayCard,
  actions,
  sheet,
  settings,
  settingsHint: 'ประเภทอุปกรณ์ ส่งออก CSV',
  exportData,
  importData,
  onInput(ev) {
    if (ev.target.id === 'maint-q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.hist.q = ev.target.value.trim();
        rerender();
      }, 250);
    }
  },
  leave() {
    cats.edit = null;
  },
  deepLink(params) {
    const add = params.get('add');
    if (add === 'maint') openLog({});
    else if (add === 'maint:asset') openAsset(null);
    else return false;
    return true;
  },
  reset() {
    store.del(CACHE);
    state.assets = [];
    state.tasks = [];
    state.logs = new Map();
    cats.edit = null;
  },
};
export default mod;
