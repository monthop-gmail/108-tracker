/* โมดูลค่าใช้จ่าย — รายการที่ต้องจ่าย (ครั้งเดียว/รายเดือน/รายปี/ผ่อน) และการจ่าย
 * - บันทึกการจ่ายเก็บลงเครื่องก่อน แล้วส่งขึ้นเซิร์ฟเวอร์ผ่าน outbox กลาง → ใช้ได้แม้เน็ตหลุด
 * - การคำนวณงวดใช้ schedule.js ไฟล์เดียวกับฝั่ง Worker
 */
import { $, $$, esc, store, today, dateObj, F_WD, F_MON, fmtFull, fmtDM, MONEY, baht as bahtOr, monthOf, monthLabel, uuid, ICON, download, csv, sheetHead } from '../../core/util.js';
import { CatEditor } from '../../core/cats.js';
import { addMonths, addDays, diffDays, dueDates, occurrences, pendingFor, scheduleText, monthlyEquivalent } from './schedule.js';

const ID = 'bills';
let ctx;
let sheetEl;
const api = (...a) => ctx.api(...a);
const toast = (...a) => ctx.toast(...a);
const handleErr = (e) => ctx.handleErr(e);
const rerender = () => ctx.rerender();
const openSheet = (html) => ctx.openSheet(mod, html);
const closeSheet = () => ctx.closeSheet();

const baht = (n) => bahtOr(n, '—');
const dueText = (days) => (days < 0 ? `เลยกำหนด ${-days} วัน` : days === 0 ? 'ครบกำหนดวันนี้' : days === 1 ? 'พรุ่งนี้' : `อีก ${days} วัน`);

// ---------- ค่าคงที่ ----------
const FALLBACK_CATS = [{ key: 'other', label: 'อื่น ๆ', emoji: '📦' }];
const METHODS = ['โอน/พร้อมเพย์', 'บัตรเครดิต', 'เงินสด', 'หักบัญชี', 'อื่น ๆ'];
const FREQS = [
  ['once', 1, 'ครั้งเดียว'],
  ['month', 1, 'ทุกเดือน'],
  ['month', 3, 'ทุก 3 เดือน'],
  ['month', 6, 'ทุก 6 เดือน'],
  ['year', 1, 'ทุกปี'],
];
const UNIT_LABEL = { week: 'สัปดาห์', month: 'เดือน', year: 'ปี' };
const NAME_PRESETS = [
  ['ค่าไฟ', 'utility', 'month'],
  ['ค่าน้ำ', 'utility', 'month'],
  ['ค่าเน็ตบ้าน', 'phone', 'month'],
  ['ค่าโทรศัพท์', 'phone', 'month'],
  ['ค่าเช่า/ผ่อนบ้าน', 'home', 'month'],
  ['ค่าส่วนกลาง', 'home', 'year'],
  ['บัตรเครดิต', 'card', 'month'],
  ['ประกันรถ', 'insurance', 'year'],
  ['ภาษีรถ/พ.ร.บ.', 'tax', 'year'],
  ['ประกันชีวิต/สุขภาพ', 'insurance', 'year'],
  ['ภาษีที่ดินฯ', 'tax', 'year'],
  ['ค่าเทอม', 'education', 'once'],
  ['Netflix/YouTube', 'subscription', 'month'],
];
const REMIND_OPTS = [0, 1, 3, 7, 14, 30];
// ---------- state ----------
const CACHE = 't108_bills';
const cache = store.get(CACHE, {});
const state = {
  bills: cache.bills || [],
  categories: cache.categories || FALLBACK_CATS,
  payments: new Map((cache.payments || []).map((p) => [p.id, p])),
  since: cache.since || null,
  touched: new Map(),
  hist: { month: monthOf(today()), q: '', older: new Map(), all: null },
};

const catOf = (key) => state.categories.find((c) => c.key === key) || { key, label: key || 'อื่น ๆ', emoji: '📦' };
const billOf = (id) => state.bills.find((b) => b.id === id);
const payList = () => [...state.payments.values()];
const pendingIds = () => ctx.pendingIds(ID);

function saveCache() {
  store.set(CACHE, { bills: state.bills, categories: state.categories, payments: payList().slice(0, 5000), since: state.since });
}

function savePayment(p) {
  const payment = {
    id: p.id,
    bill_id: p.bill_id ?? null,
    period: p.period ?? null,
    paid_date: p.paid_date,
    name: (p.name || '').trim(),
    category: p.category || 'other',
    amount: p.amount ?? null,
    method: p.method || '',
    note: (p.note || '').trim(),
    status: p.status === 'skipped' ? 'skipped' : 'paid',
    updated_at: Date.now(),
  };
  state.payments.set(payment.id, payment);
  state.touched.set(payment.id, { at: payment.updated_at, payment });
  ctx.queue(ID, { type: 'put', item: payment });
  saveCache();
  rerender();
  return payment;
}

function deletePayment(id, { silent } = {}) {
  const old = state.payments.get(id);
  if (!old) return;
  const at = Date.now();
  state.payments.delete(id);
  state.touched.set(id, { at, payment: null });
  ctx.queue(ID, { type: 'del', id, updated_at: at });
  saveCache();
  rerender();
  if (!silent) toast('ลบแล้ว', { label: 'เลิกทำ', fn: () => savePayment(old) });
}

async function refresh() {
  const t0 = Date.now();
  const r = await api('/api/bills/data');
  const map = new Map(r.payments.map((p) => [p.id, p]));
  ctx.applyOutbox(ID, '', map);
  for (const [id, t] of state.touched) {
    if (t.at >= t0 - 2000) t.payment ? map.set(id, t.payment) : map.delete(id);
    else if (Date.now() - t.at > 5 * 60000) state.touched.delete(id);
  }
  state.bills = r.bills;
  state.categories = r.categories;
  state.payments = map;
  state.since = r.since;
  state.hist.all = null;
  saveCache();
}

function toCSV(list) {
  const rows = [['วันที่จ่าย', 'รายการ', 'หมวด', 'จำนวนเงิน', 'วิธีจ่าย', 'งวด', 'สถานะ', 'หมายเหตุ']];
  for (const p of [...list].sort((a, b) => a.paid_date.localeCompare(b.paid_date))) {
    rows.push([p.paid_date, p.name, catOf(p.category).label, p.amount ?? '', p.method, p.period || '', p.status === 'skipped' ? 'ข้าม' : 'จ่ายแล้ว', p.note]);
  }
  return csv(rows);
}

// ---------- ข้อมูลที่คำนวณ ----------
function dueModel() {
  const t = today();
  const pays = payList();
  const overdue = [];
  const soon = [];
  const later = [];
  for (const b of state.bills) {
    if (!b.active) continue;
    const { overdue: od, next } = pendingFor(b, pays, t, 400);
    for (const o of od) overdue.push({ bill: b, ...o });
    if (next) {
      const item = { bill: b, ...next };
      if (next.days <= 7) soon.push(item);
      else if (next.days <= 45) later.push(item);
    }
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.bill.name.localeCompare(b.bill.name);
  return { overdue: overdue.sort(byDate), soon: soon.sort(byDate), later: later.sort(byDate) };
}

function monthSummary(ym) {
  const t = today();
  const pays = payList();
  const paid = pays.filter((p) => p.status === 'paid' && monthOf(p.paid_date) === ym);
  const first = `${ym}-01`;
  const last = addDays(addMonths(first, 1, 1), -1);
  const unpaid = [];
  for (const b of state.bills) {
    if (!b.active) continue;
    const back = Math.max(0, diffDays(first, t)) + 1;
    const ahead = Math.max(0, diffDays(t, last)) + 1;
    for (const o of occurrences(b, pays, t, { back, ahead })) {
      if (o.date >= first && o.date <= last && !o.payment) unpaid.push({ bill: b, ...o });
    }
  }
  return {
    paidTotal: paid.reduce((s, p) => s + (p.amount || 0), 0),
    paidCount: paid.length,
    dueTotal: unpaid.reduce((s, o) => s + (o.bill.amount || 0), 0),
    dueCount: unpaid.length,
    unknown: unpaid.filter((o) => o.bill.amount == null).length,
  };
}
// ---------- แถว ----------
// ---------- หน้า: ต้องจ่าย ----------
function dueRow(o, kind) {
  const b = o.bill;
  const c = catOf(b.category);
  const d = dateObj(o.date);
  const meta = [dueText(o.days), b.count ? `งวด ${o.n}/${b.count}` : '', b.autopay ? 'หักอัตโนมัติ' : ''].filter(Boolean).join(' · ');
  return `<div class="due-row ${kind}">
    <button type="button" class="due-main" data-action="bills:bill-info" data-id="${esc(b.id)}">
      <span class="due-date"><b>${d.getDate()}</b><span>${esc(F_MON.format(d))}</span></span>
      <span class="due-body">
        <span class="due-name">${esc(c.emoji)} ${esc(b.name)}</span>
        <span class="due-meta">${esc(meta)}</span>
      </span>
      <span class="due-amt">${b.amount == null ? '<small>ไม่ระบุยอด</small>' : esc(baht(b.amount))}</span>
    </button>
    <button type="button" class="btn sm ${kind === 'later' ? 'ghost' : 'primary'}" data-action="bills:pay" data-bill="${esc(b.id)}" data-period="${o.date}">จ่ายแล้ว</button>
  </div>`;
}

function payRow(p, pending) {
  const c = catOf(p.category);
  const sub = [
    p.status === 'skipped' ? 'ข้ามงวด' : fmtFull(p.paid_date),
    p.period && p.bill_id ? `งวด ${fmtDM(p.period)}` : '',
    p.method,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<button type="button" class="pay-row${p.status === 'skipped' ? ' skipped' : ''}" data-action="bills:edit-pay" data-id="${esc(p.id)}">
    <span class="pay-emoji" aria-hidden="true">${esc(c.emoji)}</span>
    <span class="pay-body"><span class="pay-name">${esc(p.name)}</span><span class="pay-meta">${esc(sub)}${p.note ? ` · ${esc(p.note)}` : ''}</span></span>
    <span class="pay-amt">${p.status === 'skipped' ? '' : esc(baht(p.amount))}${pending ? ' <span title="รอส่งขึ้นเซิร์ฟเวอร์">⏳</span>' : ''}</span>
  </button>`;
}
const dueSection = (title, list, kind, empty) =>
  list.length ? `<h2 class="sec ${kind}">${title} <span class="count">${list.length}</span></h2><div class="due-list">${list.map((o) => dueRow(o, kind)).join('')}</div>` : empty || '';

function viewHome() {
  const t = today();
  const { overdue, soon, later } = dueModel();
  const ms = monthSummary(monthOf(t));
  const pending = pendingIds();
  const recent = payList()
    .sort((a, b) => b.paid_date.localeCompare(a.paid_date) || b.updated_at - a.updated_at)
    .slice(0, 8);
  return {
    tab: '',
    title: 'ค่าใช้จ่าย',
    body: `
    <section class="month-card" aria-label="สรุปเดือนนี้">
      <div class="mc-title">${esc(monthLabel(monthOf(t)))}</div>
      <div class="mc-grid">
        <div><span>จ่ายแล้ว</span><b>${esc(baht(ms.paidTotal))}</b><small>${ms.paidCount} รายการ</small></div>
        <div><span>ยังต้องจ่าย</span><b>${esc(baht(ms.dueTotal))}</b><small>${ms.dueCount} รายการ${ms.unknown ? ` · ไม่ระบุยอด ${ms.unknown}` : ''}</small></div>
      </div>
    </section>
    <div class="action-row">
      <button type="button" class="btn primary" data-action="bills:new-pay">+ บันทึกการจ่าย</button>
      <button type="button" class="btn" data-action="bills:new-bill">+ ตั้งรายการล่วงหน้า</button>
    </div>
    ${
      !state.bills.length
        ? `<div class="hero">
            <p><b>เริ่มจากตั้งรายการที่ต้องจ่ายเป็นประจำ</b> เช่น ค่าไฟ ค่าเน็ต บัตรเครดิต ประกันรถ ภาษีรถ
            แอปจะบอกว่ารายการไหนใกล้ครบกำหนด และงวดไหนจ่ายไปแล้ว</p>
            <p class="muted">จ่ายอะไรไปแล้วที่ไม่ได้ตั้งไว้ กด "บันทึกการจ่าย" ได้เลย (ย้อนหลังได้)</p>
          </div>`
        : ''
    }
    ${dueSection('เลยกำหนด', overdue, 'overdue')}
    ${dueSection('ภายใน 7 วัน', soon, 'soon', state.bills.length && !overdue.length ? '<p class="all-clear">✓ ไม่มีรายการค้างจ่ายหรือครบกำหนดใน 7 วันนี้</p>' : '')}
    ${dueSection('ถัดไป (ภายใน 45 วัน)', later, 'later')}
    ${recent.length ? `<h2 class="sec">จ่ายล่าสุด</h2><div class="pay-list">${recent.map((p) => payRow(p, pending.has(p.id))).join('')}</div>
      <a class="more-link" href="#/bills/history">ดูประวัติทั้งหมด →</a>` : ''}`,
  };
}

// ---------- หน้า: รายการ ----------
function billCard(b) {
  const c = catOf(b.category);
  const t = today();
  const pays = payList();
  const { overdue, next } = pendingFor(b, pays, t, 800);
  const last = pays
    .filter((p) => p.bill_id === b.id && p.status === 'paid')
    .sort((x, y) => y.paid_date.localeCompare(x.paid_date))[0];
  let status;
  if (!b.active) status = 'ปิดแล้ว';
  else if (overdue.length) status = `<span class="bad">ค้างจ่าย ${overdue.length} งวด</span>`;
  else if (next) status = `งวดถัดไป ${esc(fmtFull(next.date))} (${esc(dueText(next.days))})`;
  else status = '<span class="good">จ่ายครบแล้ว</span>';
  return `<button type="button" class="bill-card${b.active ? '' : ' inactive'}" data-action="bills:bill-info" data-id="${esc(b.id)}">
    <span class="bc-emoji" aria-hidden="true">${esc(c.emoji)}</span>
    <span class="bc-body">
      <span class="bc-top"><b>${esc(b.name)}</b><span class="bc-amt">${b.amount == null ? 'ไม่ระบุยอด' : esc(baht(b.amount))}</span></span>
      <span class="bc-meta">${esc(scheduleText(b, fmtDM, fmtFull))}${b.autopay ? ' · หักอัตโนมัติ' : ''}</span>
      <span class="bc-status">${status}</span>
      ${last ? `<span class="bc-meta">จ่ายล่าสุด ${esc(fmtFull(last.paid_date))} ${esc(baht(last.amount))}</span>` : ''}
    </span>
  </button>`;
}

function viewBills() {
  const active = state.bills.filter((b) => b.active);
  const inactive = state.bills.filter((b) => !b.active);
  const groups = [
    ['รายเดือน', active.filter((b) => b.unit === 'month' && b.every === 1)],
    ['ทุกหลายเดือน / รายสัปดาห์', active.filter((b) => (b.unit === 'month' && b.every > 1) || b.unit === 'week')],
    ['รายปี', active.filter((b) => b.unit === 'year')],
    ['ครั้งเดียว', active.filter((b) => b.unit === 'once')],
  ];
  const perMonth = active.reduce((s, b) => s + monthlyEquivalent(b), 0);
  const unknown = active.filter((b) => b.unit !== 'once' && b.amount == null).length;
  const byName = (a, b) => a.name.localeCompare(b.name, 'th');
  return {
    tab: 'list',
    title: 'รายการที่ตั้งไว้',
    actions: '<button type="button" class="btn primary sm" data-action="bills:new-bill">+ ตั้งรายการ</button>',
    body: `
    ${
      active.length
        ? `<section class="month-card">
            <div class="mc-grid">
              <div><span>ภาระประจำเฉลี่ยต่อเดือน</span><b>≈ ${esc(baht(Math.round(perMonth)))}</b><small>ต่อปี ≈ ${esc(baht(Math.round(perMonth * 12)))}</small></div>
              <div><span>รายการที่ใช้อยู่</span><b>${active.length}</b><small>${unknown ? `ไม่ระบุยอด ${unknown} รายการ (ไม่นับรวม)` : 'รวมทุกรายการที่ระบุยอด'}</small></div>
            </div>
          </section>`
        : '<p class="empty">ยังไม่มีรายการ — กด "+ ตั้งรายการ" เพื่อเพิ่มค่าใช้จ่ายที่ต้องจ่ายประจำหรือที่จะต้องจ่ายในอนาคต</p>'
    }
    ${groups
      .filter(([, list]) => list.length)
      .map(([title, list]) => `<h2 class="sec">${title} <span class="count">${list.length}</span></h2><div class="bill-list">${list.sort(byName).map(billCard).join('')}</div>`)
      .join('')}
    ${inactive.length ? `<details class="stopped"><summary>ปิดแล้ว / เลิกจ่าย (${inactive.length})</summary><div class="bill-list">${inactive.sort(byName).map(billCard).join('')}</div></details>` : ''}`,
  };
}

// ---------- หน้า: ประวัติ ----------
async function ensureHistoryData() {
  const h = state.hist;
  if (h.q) {
    if (!h.all) {
      try {
        const r = await api('/api/bills/payments');
        const map = new Map(r.payments.map((p) => [p.id, p]));
        ctx.applyOutbox(ID, '', map);
        h.all = [...map.values()];
        if (ctx.isOn(ID, 'history')) rerender();
      } catch (e) {
        handleErr(e);
      }
    }
    return;
  }
  if (state.since && `${h.month}-31` < state.since && !h.older.has(h.month)) {
    const first = `${h.month}-01`;
    const last = addDays(addMonths(first, 1, 1), -1);
    try {
      const r = await api(`/api/bills/payments?from=${first}&to=${last}`);
      h.older.set(h.month, r.payments);
      if (ctx.isOn(ID, 'history')) rerender();
    } catch (e) {
      handleErr(e);
    }
  }
}

function historyList() {
  const h = state.hist;
  if (h.q) {
    const q = h.q.toLowerCase();
    const src = h.all || payList();
    return src.filter((p) => `${p.name} ${p.note} ${p.method} ${catOf(p.category).label}`.toLowerCase().includes(q));
  }
  const older = h.older.get(h.month);
  const src = older ? [...older, ...payList().filter((p) => !older.some((o) => o.id === p.id))] : payList();
  return src.filter((p) => monthOf(p.paid_date) === h.month);
}

function viewHistory() {
  const h = state.hist;
  const list = historyList().sort((a, b) => b.paid_date.localeCompare(a.paid_date) || b.updated_at - a.updated_at);
  const paid = list.filter((p) => p.status === 'paid');
  const total = paid.reduce((s, p) => s + (p.amount || 0), 0);
  const byCat = new Map();
  for (const p of paid) byCat.set(p.category, (byCat.get(p.category) || 0) + (p.amount || 0));
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 0;
  const pending = pendingIds();
  const groups = new Map();
  for (const p of list) {
    if (!groups.has(p.paid_date)) groups.set(p.paid_date, []);
    groups.get(p.paid_date).push(p);
  }
  const loadingOlder = !h.q && state.since && `${h.month}-31` < state.since && !h.older.has(h.month);
  const isCurrent = h.month >= monthOf(today());
  const searchFocused = document.activeElement && document.activeElement.id === 'bills-q';
  return {
    tab: 'history',
    title: 'ประวัติการจ่าย',
    body: `
    <input class="in search" id="bills-q" type="search" placeholder="ค้นหา เช่น ค่าไฟ — เคยจ่ายเมื่อไร" value="${esc(h.q)}" autocomplete="off">
    ${
      h.q
        ? `<p class="range-label">ผลการค้นหา "${esc(h.q)}" ${h.all ? 'จากประวัติทั้งหมด' : '(กำลังค้นในประวัติทั้งหมด…)'} · ${list.length} รายการ</p>`
        : `<div class="month-nav">
            <button type="button" class="icon-btn" data-action="bills:hist-prev" aria-label="เดือนก่อน">${ICON.prev}</button>
            <b>${esc(monthLabel(h.month))}</b>
            <button type="button" class="icon-btn" data-action="bills:hist-next" aria-label="เดือนถัดไป" ${isCurrent ? 'disabled' : ''}>${ICON.next}</button>
          </div>`
    }
    <section class="month-card">
      <div class="mc-grid">
        <div><span>${h.q ? 'รวมที่พบ' : 'จ่ายรวม'}</span><b>${esc(baht(total))}</b><small>${paid.length} รายการ</small></div>
        <div class="cat-bars">${cats
          .slice(0, 5)
          .map(([k, v]) => `<div class="cb"><span>${esc(catOf(k).emoji)} ${esc(catOf(k).label)}</span><i><em data-w="${max ? Math.max(4, Math.round((v / max) * 100)) : 0}"></em></i><b>${esc(baht(v))}</b></div>`)
          .join('')}</div>
      </div>
    </section>
    ${loadingOlder ? '<p class="muted">กำลังโหลดเดือนนี้…</p>' : ''}
    ${
      list.length
        ? [...groups.entries()]
            .map(([d, ps]) => `<h2 class="day-head">${esc(F_WD.format(dateObj(d)))} ${esc(String(dateObj(d).getFullYear() + 543))}</h2><div class="pay-list">${ps.map((p) => payRow(p, pending.has(p.id))).join('')}</div>`)
            .join('')
        : loadingOlder
          ? ''
          : `<p class="empty">${h.q ? 'ไม่พบรายการ' : 'ไม่มีการจ่ายในเดือนนี้'}</p>`
    }
    <div class="row no-print">
      <button type="button" class="btn ghost" data-action="bills:hist-csv" ${list.length ? '' : 'disabled'}>ดาวน์โหลด CSV ${h.q ? 'ผลการค้นหา' : 'เดือนนี้'}</button>
    </div>`,
    after() {
      for (const em of $$('.cat-bars em')) em.style.width = `${em.dataset.w}%`; // CSP ไม่อนุญาต style ในแท็ก จึงตั้งผ่าน JS
      if (searchFocused) {
        const q = $('#bills-q');
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      }
      ensureHistoryData();
    },
  };
}

function view(path) {
  if (path === 'list') return viewBills();
  if (path === 'history') return viewHistory();
  return viewHome();
}

// ---------- หน้า "วันนี้" ----------
function todayCard() {
  const { overdue, soon } = dueModel();
  const list = [...overdue.map((o) => [o, 'overdue']), ...soon.map((o) => [o, 'soon'])];
  if (!list.length) return '';
  const total = list.reduce((s, [o]) => s + (o.bill.amount || 0), 0);
  return `<div class="due-list">${list
    .slice(0, 5)
    .map(([o, k]) => dueRow(o, k))
    .join('')}</div>
    <p class="tc-foot">${overdue.length ? `<span class="bad">ค้าง ${overdue.length}</span> · ` : ''}ภายใน 7 วัน ${soon.length} รายการ${total ? ` · รวม ≈ ${esc(baht(total))}` : ''}${list.length > 5 ? ` · <a href="#/bills">ดูทั้งหมด</a>` : ''}</p>`;
}

// ---------- แผ่น (bottom sheet) ----------
let mode = null; // 'pay' | 'bill' | 'info'
let P = null;
let B = null;
let I = null;

// ----- บันทึกการจ่าย -----
function openPay({ bill, period, payment }) {
  mode = 'pay';
  if (payment) P = { ...payment, isNew: false };
  else if (bill)
    P = { id: uuid(), bill_id: bill.id, period, paid_date: today(), name: bill.name, category: bill.category, amount: bill.amount, method: bill.method || '', note: '', status: 'paid', isNew: true };
  else P = { id: uuid(), bill_id: null, period: null, paid_date: today(), name: '', category: 'other', amount: null, method: '', note: '', status: 'paid', isNew: true };
  renderPay();
}

function renderPay() {
  const bill = P.bill_id ? billOf(P.bill_id) : null;
  const t = today();
  const occ = bill && P.period ? occurrences(bill, [], t, { back: Math.max(0, diffDays(P.period, t)) + 1, ahead: Math.max(0, diffDays(t, P.period)) + 1 }).find((o) => o.date === P.period) : null;
  const visibleCats = state.categories.filter((c) => !c.hidden || c.key === P.category);
  const recentNames = [...new Set(payList().filter((p) => !p.bill_id).sort((a, b) => b.updated_at - a.updated_at).map((p) => p.name))].slice(0, 8);
  const title = P.isNew ? (bill ? `จ่าย ${esc(bill.name)}` : 'บันทึกการจ่าย') : P.status === 'skipped' ? 'งวดที่ข้าม' : 'แก้ไขการจ่าย';
  openSheet(`
    <form class="sheet-body" id="pay-form" novalidate>
      ${sheetHead(title)}
      ${
        P.bill_id
          ? `<div class="info-box">
              <div><b>${esc(P.name)}</b>${P.period ? ` · งวดครบกำหนด ${esc(fmtFull(P.period))}` : ''}${occ ? ` (${esc(dueText(diffDays(t, P.period)))})` : ''}${
                bill && bill.count && occ ? ` · งวดที่ ${occ.n}/${bill.count}` : ''
              }</div>
              ${bill && bill.details ? `<div class="details">${esc(bill.details)}</div>` : ''}
              ${!bill ? '<div class="muted">รายการนี้ถูกลบไปแล้ว (ประวัติยังอยู่)</div>' : ''}
            </div>`
          : `<div class="field"><label for="p-name">จ่ายค่าอะไร *</label>
              <input id="p-name" maxlength="120" value="${esc(P.name)}" placeholder="เช่น ค่าซ่อมแอร์, ค่าธรรมเนียมรายปี" autocomplete="off">
              ${recentNames.length ? `<div class="chips">${recentNames.map((n) => `<button type="button" class="chip soft" data-x="p-name" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
            </div>
            <div class="field"><span class="label">หมวด</span>
              <div class="chips">${visibleCats.map((c) => `<button type="button" class="chip${P.category === c.key ? ' on' : ''}" data-x="p-cat" data-v="${esc(c.key)}">${esc(c.emoji)} ${esc(c.label)}</button>`).join('')}</div>
            </div>`
      }
      ${
        P.status === 'skipped'
          ? '<p class="hint">งวดนี้ถูกทำเครื่องหมายว่าข้าม (ไม่ต้องจ่าย/ไม่นับยอด) — ลบเพื่อให้กลับมาเป็นงวดค้างจ่าย</p>'
          : `<div class="field"><label for="p-amount">จำนวนเงิน (บาท)</label>
              <input id="p-amount" inputmode="decimal" autocomplete="off" value="${P.amount == null ? '' : esc(P.amount)}" placeholder="${bill && bill.amount != null ? esc(MONEY.format(bill.amount)) : '0'}">
              ${bill && bill.amount != null ? `<p class="hint">ยอดปกติ ${esc(baht(bill.amount))}</p>` : ''}
            </div>
            <div class="field"><label for="p-date">วันที่จ่าย</label>
              <input id="p-date" type="date" value="${esc(P.paid_date)}" max="${esc(addDays(t, 1))}">
              <div class="chips">
                <button type="button" class="chip soft" data-x="p-date" data-v="${t}">วันนี้</button>
                <button type="button" class="chip soft" data-x="p-date" data-v="${addDays(t, -1)}">เมื่อวาน</button>
                ${P.period && P.period <= t ? `<button type="button" class="chip soft" data-x="p-date" data-v="${P.period}">วันครบกำหนด</button>` : ''}
              </div>
            </div>
            <div class="field"><span class="label">จ่ายด้วย</span>
              <div class="chips">${METHODS.map((m) => `<button type="button" class="chip${P.method === m ? ' on' : ''}" data-x="p-method" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
            </div>
            <div class="field"><label for="p-note">หมายเหตุ <small>(ไม่ใส่ก็ได้)</small></label>
              <textarea id="p-note" rows="2" maxlength="1000" placeholder="เช่น เลขอ้างอิงการโอน, จ่ายผ่านแอปธนาคาร">${esc(P.note)}</textarea>
            </div>`
      }
      <div class="sheet-actions wrap">
        ${P.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="p-del">ลบ</button>'}
        ${P.isNew && P.bill_id ? '<button type="button" class="btn ghost" data-x="p-skip" title="ไม่ต้องจ่ายงวดนี้">ข้ามงวดนี้</button>' : ''}
        ${P.status === 'skipped' ? '' : `<button type="submit" class="btn primary">${P.isNew ? '✓ บันทึกว่าจ่ายแล้ว' : 'บันทึก'}</button>`}
      </div>
    </form>`);
}

function parseAmount(v) {
  const s = String(v || '').replace(/[,\s฿]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

function submitPay() {
  if (!P.bill_id) {
    P.name = $('#p-name', sheetEl).value.trim();
    if (!P.name) return toast('กรุณาใส่ว่าจ่ายค่าอะไร');
  }
  const amount = parseAmount($('#p-amount', sheetEl).value);
  if (Number.isNaN(amount)) return toast('จำนวนเงินไม่ถูกต้อง');
  const date = $('#p-date', sheetEl).value;
  if (!date) return toast('กรุณาระบุวันที่จ่าย');
  P.amount = amount;
  P.paid_date = date;
  P.note = $('#p-note', sheetEl).value;
  const wasNew = P.isNew;
  const p = savePayment(P);
  closeSheet();
  toast(wasNew ? `บันทึกแล้ว: ${p.name}${p.amount != null ? ` ${baht(p.amount)}` : ''}` : 'แก้ไขแล้ว', wasNew ? { label: 'เลิกทำ', fn: () => deletePayment(p.id, { silent: true }) } : undefined);
}

// ----- ตั้ง/แก้รายการ -----
function openBill(bill, preset) {
  mode = 'bill';
  B = bill
    ? { ...bill, isNew: false }
    : {
        id: uuid(),
        name: '',
        category: 'other',
        amount: null,
        unit: 'month',
        every: 1,
        start_due: today(),
        end_date: null,
        count: null,
        remind_days: 3,
        autopay: false,
        method: '',
        details: '',
        active: true,
        isNew: true,
        ...(preset || {}),
      };
  B.custom = !FREQS.some(([u, e]) => u === B.unit && e === B.every);
  renderBill();
}

function previewText(b) {
  if (!b.start_due) return '';
  const t = today();
  const from = b.start_due < t ? t : b.start_due;
  const next = dueDates(b, from, addDays(from, 3 * 400), 3);
  const pastCount = b.start_due < t ? dueDates(b, b.start_due, addDays(t, -1), 1000).length : 0;
  let s = next.length ? `ครบกำหนด: ${next.map((o) => fmtFull(o.date)).join(' · ')}${b.unit !== 'once' && next.length === 3 ? ' …' : ''}` : 'ไม่มีงวดที่จะถึงแล้ว';
  if (pastCount && b.isNew) s += `<br><span class="warn">มี ${pastCount} งวดที่วันครบกำหนดผ่านมาแล้ว จะขึ้นเป็น "เลยกำหนด" — ถ้าจ่ายแล้วกด "จ่ายแล้ว" บันทึกย้อนหลัง หรือ "ข้ามงวดนี้"</span>`;
  return s;
}

function renderBill() {
  const b = B;
  const visibleCats = state.categories.filter((c) => !c.hidden || c.key === b.category);
  const recurring = b.unit !== 'once';
  openSheet(`
    <form class="sheet-body" id="bill-form" novalidate>
      ${sheetHead(b.isNew ? 'ตั้งรายการค่าใช้จ่าย' : 'แก้ไขรายการ')}
      <div class="field"><label for="b-name">ชื่อรายการ *</label>
        <input id="b-name" maxlength="120" value="${esc(b.name)}" placeholder="เช่น ค่าไฟ, ประกันรถ" autocomplete="off">
        ${b.isNew ? `<div class="chips">${NAME_PRESETS.map(([n]) => `<button type="button" class="chip soft" data-x="b-preset" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><span class="label">หมวด</span>
        <div class="chips">${visibleCats.map((c) => `<button type="button" class="chip${b.category === c.key ? ' on' : ''}" data-x="b-cat" data-v="${esc(c.key)}">${esc(c.emoji)} ${esc(c.label)}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="b-amount">จำนวนเงินต่องวด (บาท)</label>
        <input id="b-amount" inputmode="decimal" autocomplete="off" value="${b.amount == null ? '' : esc(b.amount)}" placeholder="เว้นว่างได้ถ้ายอดไม่แน่นอน เช่น ค่าไฟ">
      </div>
      <div class="field"><span class="label">รอบการจ่าย</span>
        <div class="chips">${FREQS.map(
          ([u, e, label]) => `<button type="button" class="chip${!b.custom && b.unit === u && b.every === e ? ' on' : ''}" data-x="b-freq" data-u="${u}" data-e="${e}">${label}</button>`
        ).join('')}<button type="button" class="chip${b.custom ? ' on' : ''}" data-x="b-custom">กำหนดเอง</button></div>
        ${
          b.custom
            ? `<div class="custom-freq">ทุก <input id="b-every" class="in" type="number" min="1" max="60" value="${esc(b.every)}">
                <select id="b-unit" class="in">${Object.entries(UNIT_LABEL).map(([u, l]) => `<option value="${u}" ${b.unit === u ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`
            : ''
        }
      </div>
      <div class="field"><label for="b-start">${recurring ? 'วันครบกำหนดงวดแรก' : 'วันที่ต้องจ่าย'}</label>
        <input id="b-start" type="date" value="${esc(b.start_due)}">
        ${recurring ? '<p class="hint">งวดต่อไปจะครบกำหนดวันที่เดียวกันของแต่ละรอบ (ถ้าเดือนนั้นไม่มีวันที่นั้น ใช้วันสุดท้ายของเดือน)</p>' : ''}
      </div>
      ${
        recurring
          ? `<div class="field two">
              <div><label for="b-count">จำนวนงวด <small>(ผ่อน)</small></label><input id="b-count" class="in" type="number" min="1" max="600" value="${b.count ?? ''}" placeholder="ไม่จำกัด"></div>
              <div><label for="b-end">สิ้นสุด <small>(ไม่บังคับ)</small></label><input id="b-end" type="date" value="${esc(b.end_date || '')}"></div>
            </div>`
          : ''
      }
      <p class="preview" id="b-preview">${previewText(b)}</p>
      <div class="field"><span class="label">เตือนล่วงหน้า</span>
        <div class="chips">${REMIND_OPTS.map(
          (d) => `<button type="button" class="chip${b.remind_days === d ? ' on' : ''}" data-x="b-remind" data-v="${d}">${d === 0 ? 'วันครบกำหนด' : `${d} วันก่อน`}</button>`
        ).join('')}</div>
      </div>
      <div class="field"><span class="label">จ่ายด้วย (ปกติ)</span>
        <div class="chips">${METHODS.map((m) => `<button type="button" class="chip${b.method === m ? ' on' : ''}" data-x="b-method" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
      </div>
      <label class="check big"><input type="checkbox" id="b-autopay" ${b.autopay ? 'checked' : ''}> หักบัญชี/ตัดบัตรอัตโนมัติ <span class="muted">(ยังเตือนให้ตรวจสอบ)</span></label>
      <div class="field"><label for="b-details">รายละเอียดสำหรับจ่าย</label>
        <textarea id="b-details" rows="2" maxlength="1000" placeholder="เช่น เลขผู้ใช้ไฟฟ้า, เลขกรมธรรม์, เลขบัญชี/พร้อมเพย์">${esc(b.details)}</textarea>
      </div>
      ${b.isNew ? '' : `<label class="check big"><input type="checkbox" id="b-active" ${b.active ? 'checked' : ''}> ยังต้องจ่ายอยู่ <span class="muted">(เอาออก = เลิกจ่ายแล้ว ไม่เตือน)</span></label>`}
      <div class="sheet-actions">
        ${b.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="b-del">ลบ</button>'}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
}

function readBill() {
  const b = B;
  b.name = $('#b-name', sheetEl).value.trim();
  b.amount = parseAmount($('#b-amount', sheetEl).value);
  b.start_due = $('#b-start', sheetEl).value;
  if (b.custom) {
    b.every = Math.max(1, Math.min(60, parseInt($('#b-every', sheetEl).value, 10) || 1));
    b.unit = $('#b-unit', sheetEl).value;
  }
  const cnt = $('#b-count', sheetEl);
  b.count = cnt && cnt.value ? parseInt(cnt.value, 10) : null;
  const end = $('#b-end', sheetEl);
  b.end_date = end && end.value ? end.value : null;
  b.autopay = $('#b-autopay', sheetEl).checked;
  b.details = $('#b-details', sheetEl).value.trim();
  const act = $('#b-active', sheetEl);
  if (act) b.active = act.checked;
}

async function submitBill() {
  readBill();
  if (!B.name) return toast('กรุณาใส่ชื่อรายการ');
  if (Number.isNaN(B.amount)) return toast('จำนวนเงินไม่ถูกต้อง');
  if (!B.start_due) return toast('กรุณาระบุวันครบกำหนด');
  if (B.end_date && B.end_date < B.start_due) return toast('วันสิ้นสุดต้องไม่ก่อนงวดแรก');
  const { isNew, custom, ...bill } = B;
  try {
    const r = await api(`/api/bills/items/${encodeURIComponent(bill.id)}`, { method: 'PUT', body: { bill } });
    const i = state.bills.findIndex((x) => x.id === bill.id);
    if (i >= 0) state.bills[i] = r.bill;
    else state.bills.push(r.bill);
    saveCache();
    closeSheet();
    const { next } = pendingFor(r.bill, payList(), today(), 800);
    toast(isNew ? `ตั้งรายการแล้ว${next ? ` · ครบกำหนด ${fmtFull(next.date)}` : ''}` : 'บันทึกแล้ว');
    rerender();
  } catch (e) {
    if (!handleErr(e)) toast(`บันทึกไม่สำเร็จ (${e.code || e.message})`);
    else if (e.network) toast('ต้องต่ออินเทอร์เน็ตเพื่อตั้ง/แก้รายการ');
  }
}

// ----- รายละเอียดรายการ + งวดทั้งหมด -----
function openInfo(billId) {
  const bill = billOf(billId);
  if (!bill) return;
  mode = 'info';
  I = { id: billId };
  renderInfo();
}

function renderInfo() {
  const b = billOf(I.id);
  if (!b) return closeSheet();
  const c = catOf(b.category);
  const t = today();
  const pays = payList();
  const occ = occurrences(b, pays, t, { back: 400, ahead: 400 });
  const past = occ.filter((o) => o.days < 0 || o.payment);
  const future = occ.filter((o) => o.days >= 0 && !o.payment).slice(0, 2);
  const rows = [...future.reverse(), ...past.reverse()].slice(0, 16);
  const extra = pays
    .filter((p) => p.bill_id === b.id && !occ.some((o) => o.payment && o.payment.id === p.id))
    .sort((x, y) => y.paid_date.localeCompare(x.paid_date))
    .slice(0, 5);
  openSheet(`
    <div class="sheet-body">
      ${sheetHead(`${esc(c.emoji)} ${esc(b.name)}`)}
      <div class="info-box">
        <div><b>${b.amount == null ? 'ไม่ระบุยอด' : esc(baht(b.amount))}</b> · ${esc(scheduleText(b, fmtDM, fmtFull))}</div>
        <div class="muted">${esc(c.label)}${b.method ? ` · จ่ายด้วย ${esc(b.method)}` : ''}${b.autopay ? ' · หักอัตโนมัติ' : ''} · เตือน${b.remind_days ? ` ${b.remind_days} วันก่อน` : 'วันครบกำหนด'}${b.active ? '' : ' · ปิดแล้ว'}</div>
        ${b.details ? `<div class="details">${esc(b.details)}</div>` : ''}
      </div>
      <h3 class="sec">งวดและการจ่าย</h3>
      ${rows.length ? '' : '<p class="empty">ยังไม่มีงวด</p>'}
      <div class="occ-list">${rows
        .map((o) => {
          const p = o.payment;
          let st;
          let cls;
          if (p && p.status === 'skipped') {
            st = 'ข้ามงวดนี้';
            cls = 'skip';
          } else if (p) {
            st = `✓ จ่ายแล้ว ${fmtFull(p.paid_date)}${p.amount != null ? ` · ${baht(p.amount)}` : ''}${p.method ? ` · ${p.method}` : ''}`;
            cls = 'ok';
          } else if (o.days < 0) {
            st = `ยังไม่จ่าย · ${dueText(o.days)}`;
            cls = 'bad';
          } else {
            st = `ยังไม่ถึงกำหนด · ${dueText(o.days)}`;
            cls = 'wait';
          }
          return `<button type="button" class="occ ${cls}" data-x="${p ? 'i-edit' : 'i-pay'}" data-period="${o.date}" ${p ? `data-id="${esc(p.id)}"` : ''}>
            <span class="occ-date">${esc(fmtFull(o.date))}${b.count ? `<small>งวด ${o.n}/${b.count}</small>` : ''}</span>
            <span class="occ-st">${esc(st)}</span>
          </button>`;
        })
        .join('')}</div>
      ${
        extra.length
          ? `<p class="hint">การจ่ายอื่นของรายการนี้ (บันทึกไว้ก่อนเปลี่ยนรอบ/วันที่):</p><div class="pay-list">${extra.map((p) => payRow(p, false)).join('')}</div>`
          : ''
      }
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-x="i-editbill">แก้ไขรายการ</button>
        ${future.length || past.some((o) => !o.payment) ? '<button type="button" class="btn primary" data-x="i-paynext">จ่ายงวดที่ค้าง/ถัดไป</button>' : ''}
      </div>
    </div>`);
}
// ----- events ของแผ่น -----
async function sheetClick(ev, b, x) {

  if (mode === 'pay' && P) {
    if (x === 'p-name') $('#p-name', sheetEl).value = b.dataset.v;
    else if (x === 'p-cat' || x === 'p-method') {
      const field = x === 'p-cat' ? 'category' : 'method';
      P[field] = x === 'p-method' && P.method === b.dataset.v ? '' : b.dataset.v;
      for (const c of $$(`[data-x="${x}"]`, sheetEl)) c.classList.toggle('on', c.dataset.v === P[field]);
    } else if (x === 'p-date') $('#p-date', sheetEl).value = b.dataset.v;
    else if (x === 'p-del') {
      const id = P.id;
      closeSheet();
      deletePayment(id);
    } else if (x === 'p-skip') {
      const p = savePayment({ ...P, status: 'skipped', amount: null, paid_date: today(), note: 'ข้ามงวด' });
      closeSheet();
      toast(`ข้ามงวด ${fmtFull(p.period)} แล้ว`, { label: 'เลิกทำ', fn: () => deletePayment(p.id, { silent: true }) });
    }
  } else if (mode === 'bill' && B) {
    if (x === 'b-preset') {
      readBill();
      const [name, cat, unit] = NAME_PRESETS.find((n) => n[0] === b.dataset.v);
      Object.assign(B, { name, category: cat, unit, every: 1, custom: false });
      renderBill();
    } else if (x === 'b-cat' || x === 'b-method') {
      const field = x === 'b-cat' ? 'category' : 'method';
      B[field] = x === 'b-method' && B.method === b.dataset.v ? '' : b.dataset.v;
      for (const c of $$(`[data-x="${x}"]`, sheetEl)) c.classList.toggle('on', c.dataset.v === B[field]);
    } else if (x === 'b-freq') {
      readBill();
      Object.assign(B, { unit: b.dataset.u, every: Number(b.dataset.e), custom: false });
      renderBill();
    } else if (x === 'b-custom') {
      readBill();
      B.custom = true;
      if (B.unit === 'once') B.unit = 'month';
      renderBill();
    } else if (x === 'b-remind') {
      B.remind_days = Number(b.dataset.v);
      for (const c of $$('[data-x="b-remind"]', sheetEl)) c.classList.toggle('on', Number(c.dataset.v) === B.remind_days);
    } else if (x === 'b-del') {
      if (!confirm(`ลบรายการ "${B.name}"? (ประวัติการจ่ายยังอยู่ — ถ้าแค่เลิกจ่าย ให้เอาเครื่องหมาย "ยังต้องจ่ายอยู่" ออกแทน)`)) return;
      try {
        await api(`/api/bills/items/${encodeURIComponent(B.id)}`, { method: 'DELETE' });
        state.bills = state.bills.filter((x2) => x2.id !== B.id);
        saveCache();
        closeSheet();
        toast('ลบรายการแล้ว');
        rerender();
      } catch (e) {
        if (!handleErr(e)) toast('ลบไม่สำเร็จ');
      }
    }
  } else if (mode === 'info' && I) {
    const bill = billOf(I.id);
    if (x === 'i-pay') openPay({ bill, period: b.dataset.period });
    else if (x === 'i-edit') {
      const p = state.payments.get(b.dataset.id);
      if (p) openPay({ payment: p });
    } else if (x === 'i-editbill') openBill(bill);
    else if (x === 'i-paynext') {
      const { overdue, next } = pendingFor(bill, payList(), today(), 800);
      const o = overdue[0] || next;
      if (o) openPay({ bill, period: o.date });
    }
  }
}

const sheet = {
  click: sheetClick,
  input() {
    if (mode === 'bill' && B) {
      readBill();
      const pv = $('#b-preview', sheetEl);
      if (pv) pv.innerHTML = previewText(B);
    }
  },
  submit(ev) {
    if (ev.target.id === 'pay-form' && P) submitPay();
    else if (ev.target.id === 'bill-form' && B) submitBill();
  },
  closed() {
    mode = P = B = I = null;
  },
};
// ---------- ตั้งค่า / สำรอง ----------
const cats = new CatEditor({ mod: ID, path: '/categories', noun: 'หมวด' });

function settings() {
  return `<h3>หมวดค่าใช้จ่าย</h3>
    <p class="hint">แก้ไอคอน ชื่อ ลำดับ หรือซ่อนหมวดที่ไม่ใช้</p>
    ${cats.html(state.categories)}
    <div class="row"><button type="button" class="btn ghost" data-action="bills:export-csv">ส่งออกประวัติการจ่ายทั้งหมด (CSV)</button></div>`;
}

async function exportData() {
  const [d, all] = await Promise.all([api('/api/bills/data'), api('/api/bills/payments')]);
  return { categories: d.categories, bills: d.bills, payments: all.payments };
}

async function importData(data) {
  const list = Array.isArray(data && data.bills) ? data.bills : [];
  const pays = Array.isArray(data && data.payments) ? data.payments : [];
  if (!list.length && !pays.length) return '';
  if (!confirm(`ค่าใช้จ่าย: นำเข้า ${list.length} รายการที่ตั้งไว้ และ ${pays.length} การจ่าย? (ข้อมูลที่ id ซ้ำจะถูกแทนถ้าไฟล์ใหม่กว่า)`)) return '';
  for (const bill of list) await api(`/api/bills/items/${encodeURIComponent(bill.id)}`, { method: 'PUT', body: { bill } });
  let rejected = 0;
  for (let i = 0; i < pays.length; i += 200) {
    const r = await api('/api/sync', { method: 'POST', body: { ops: pays.slice(i, i + 200).map((item) => ({ mod: ID, type: 'put', item })) } });
    rejected += r.rejected.length;
  }
  if (Array.isArray(data.categories) && confirm('ในไฟล์มีหมวดค่าใช้จ่ายด้วย ต้องการใช้หมวดจากไฟล์ไหม?')) {
    await api('/api/bills/categories', { method: 'PUT', body: { categories: data.categories } });
    cats.edit = null;
  }
  return `รายการ ${list.length} · การจ่าย ${pays.length - rejected}${rejected ? ` (ข้าม ${rejected})` : ''}`;
}

// ---------- actions ----------
const findPay = (id) => state.payments.get(id) || (state.hist.all || []).find((x) => x.id === id) || [...state.hist.older.values()].flat().find((x) => x.id === id);

const actions = {
  pay: (b) => openPay({ bill: billOf(b.dataset.bill), period: b.dataset.period }),
  'new-pay': () => openPay({}),
  'new-bill': () => openBill(null),
  'bill-info': (b) => openInfo(b.dataset.id),
  'edit-pay': (b) => {
    const p = findPay(b.dataset.id);
    if (p) openPay({ payment: p });
  },
  'hist-prev': () => {
    state.hist.month = monthOf(addMonths(`${state.hist.month}-01`, -1, 1));
    rerender();
  },
  'hist-next': () => {
    state.hist.month = monthOf(addMonths(`${state.hist.month}-01`, 1, 1));
    rerender();
  },
  'hist-csv': () => {
    const h = state.hist;
    download(h.q ? `bills_search.csv` : `bills_${h.month}.csv`, toCSV(historyList()), 'text/csv;charset=utf-8');
  },
  'export-csv': async () => {
    try {
      const all = await api('/api/bills/payments');
      download(`bills_all_${today()}.csv`, toCSV(all.payments), 'text/csv;charset=utf-8');
    } catch (e) {
      if (!handleErr(e)) toast('ส่งออกไม่สำเร็จ');
      else toast('ต้องต่ออินเทอร์เน็ตเพื่อส่งออก');
    }
  },
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
  label: 'ค่าใช้จ่าย',
  short: 'ค่าใช้จ่าย',
  emoji: '💸',
  icon: 'receipt',
  about: 'ค่าใช้จ่ายครั้งเดียว/รายเดือน/รายปี จ่ายแล้วหรือยัง',
  tabs: [
    ['', 'ต้องจ่าย'],
    ['list', 'รายการ'],
    ['history', 'ประวัติ'],
  ],
  quick: [{ label: 'บันทึกการจ่าย', action: 'bills:new-pay' }],
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
  settingsHint: 'หมวด ส่งออก CSV',
  exportData,
  importData,
  onInput(ev) {
    if (ev.target.id === 'bills-q') {
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
    if (add === 'bills') openPay({});
    else if (add === 'bills:bill') openBill(null);
    else return false;
    return true;
  },
  reset() {
    store.del(CACHE);
    state.bills = [];
    state.payments = new Map();
    state.hist = { month: monthOf(today()), q: '', older: new Map(), all: null };
    cats.edit = null;
  },
};
export default mod;
