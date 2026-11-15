/* โมดูลของในบ้าน — ของที่มี จำนวน จุดสั่งซื้อ วันหมดอายุ และรายการซื้อของ
 * - ทุกการแก้ไข (กด + / − / ติ๊กว่าซื้อแล้ว) เก็บลงเครื่องก่อน แล้วซิงก์ผ่าน outbox กลาง
 *   → ใช้ในห้างที่สัญญาณไม่ดีได้
 * - ของที่เหลือถึงจุดสั่งซื้อจะขึ้นในรายการซื้อของให้อัตโนมัติ
 */
import { $, esc, store, today, dateObj, F_MON, fmtFull, NUM2, baht, uuid, parseNum, download, csv, sheetHead, ICON } from '../../core/util.js';
import { CatEditor } from '../../core/cats.js';
import { addDays, expiryLeft, isLow, buyAmount, itemState } from './logic.js';

const ID = 'pantry';
let ctx;
let sheetEl;
const api = (...a) => ctx.api(...a);
const toast = (...a) => ctx.toast(...a);
const handleErr = (e) => ctx.handleErr(e);
const rerender = () => ctx.rerender();
const openSheet = (html) => ctx.openSheet(mod, html);
const closeSheet = () => ctx.closeSheet();

const fmtQ = (n) => NUM2.format(n ?? 0);
const UNITS = ['ชิ้น', 'ขวด', 'ถุง', 'กล่อง', 'แพ็ก', 'ห่อ', 'กระป๋อง', 'ฟอง', 'กก.', 'ลิตร', 'หลอด', 'ม้วน'];
// ของที่ซื้อบ่อย: [ชื่อ, ที่เก็บ, หน่วย, จุดสั่งซื้อ, ซื้อครั้งละ]
const PRESETS = [
  ['นมจืด', 'fridge', 'กล่อง', 2, 6],
  ['ไข่ไก่', 'fridge', 'ฟอง', 4, 10],
  ['ข้าวสาร', 'kitchen', 'ถุง', 0, 1],
  ['น้ำมันพืช', 'kitchen', 'ขวด', 0, 1],
  ['น้ำปลา', 'kitchen', 'ขวด', 0, 1],
  ['น้ำดื่ม', 'kitchen', 'แพ็ก', 1, 2],
  ['กระดาษทิชชู่', 'bathroom', 'ม้วน', 4, 12],
  ['ยาสีฟัน', 'bathroom', 'หลอด', 0, 1],
  ['สบู่/สบู่เหลว', 'bathroom', 'ขวด', 0, 1],
  ['แชมพู', 'bathroom', 'ขวด', 0, 1],
  ['น้ำยาล้างจาน', 'cleaning', 'ขวด', 0, 1],
  ['ผงซักฟอก/น้ำยาซักผ้า', 'cleaning', 'ถุง', 0, 1],
  ['พาราเซตามอล', 'medicine', 'แผง', 1, 2],
  ['พลาสเตอร์ยา', 'medicine', 'กล่อง', 0, 1],
];
const STATE_ORDER = { expired: 0, expiring: 1, out: 2, low: 3, ok: 4 };

// ---------- state ----------
const CACHE = 't108_pantry';
const cache = store.get(CACHE, {});
const FALLBACK_PLACES = [{ key: 'other', label: 'อื่น ๆ', emoji: '📦' }];
const state = {
  items: new Map((cache.items || []).map((x) => [x.id, x])),
  shop: new Map((cache.shop || []).map((x) => [x.id, x])),
  places: cache.places || FALLBACK_PLACES,
  touched: { items: new Map(), shop: new Map() },
  filter: { place: '', q: '' },
};

const placeOf = (key) => state.places.find((c) => c.key === key) || { key, label: key || 'อื่น ๆ', emoji: '📦' };
const items = () => [...state.items.values()];
const shopList = () => [...state.shop.values()];
const unitOf = (x) => (x.unit ? ` ${x.unit}` : '');

function saveCache() {
  store.set(CACHE, { items: items(), shop: shopList(), places: state.places });
}

function put(table, row) {
  const item = { ...row, updated_at: Date.now() };
  delete item.isNew;
  state[table].set(item.id, item);
  state.touched[table].set(item.id, { at: item.updated_at, row: item });
  ctx.queue(ID, { table, type: 'put', item });
  saveCache();
  return item;
}

function del(table, id) {
  const old = state[table].get(id);
  if (!old) return null;
  const at = Date.now();
  state[table].delete(id);
  state.touched[table].set(id, { at, row: null });
  ctx.queue(ID, { table, type: 'del', id, updated_at: at });
  saveCache();
  return old;
}

async function refresh() {
  const t0 = Date.now();
  const r = await api('/api/pantry/data');
  for (const table of ['items', 'shop']) {
    const map = new Map(r[table].map((x) => [x.id, x]));
    ctx.applyOutbox(ID, table, map);
    for (const [id, t] of state.touched[table]) {
      if (t.at >= t0 - 2000) t.row ? map.set(id, t.row) : map.delete(id);
      else if (Date.now() - t.at > 5 * 60000) state.touched[table].delete(id);
    }
    state[table] = map;
  }
  state.places = r.places;
  saveCache();
}

// ---------- ข้อมูลที่คำนวณ ----------
/** รายการซื้อของ: ของที่ถึงจุดสั่งซื้อ (อัตโนมัติ) + ที่เพิ่มเอง */
function shoppingModel() {
  const open = shopList().filter((s) => !s.done_at);
  const linked = new Set(open.filter((s) => s.item_id).map((s) => s.item_id));
  const auto = items()
    .filter((i) => isLow(i) && !linked.has(i.id))
    .sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name, 'th'));
  const done = shopList()
    .filter((s) => s.done_at)
    .sort((a, b) => b.done_at - a.done_at);
  return { auto, manual: open.sort((a, b) => a.updated_at - b.updated_at), done };
}

function expiryText(it, t) {
  const d = expiryLeft(it, t);
  if (d == null) return '';
  if (d < 0) return `หมดอายุแล้ว ${-d} วัน`;
  if (d === 0) return 'หมดอายุวันนี้';
  if (d === 1) return 'หมดอายุพรุ่งนี้';
  return d <= 60 ? `หมดอายุในอีก ${d} วัน` : `หมดอายุ ${fmtFull(it.expires_on)}`;
}

function badges(it, t) {
  const st = itemState(it, t);
  const out = [];
  if (st === 'expired') out.push(`<span class="bad">${esc(expiryText(it, t))}</span>`);
  else if (st === 'expiring') out.push(`<span class="warn">${esc(expiryText(it, t))}</span>`);
  if (it.qty <= 0) out.push('<span class="bad">หมดแล้ว</span>');
  else if (isLow(it)) out.push('<span class="warn">เหลือน้อย</span>');
  if (st !== 'expired' && st !== 'expiring' && it.expires_on) out.push(esc(expiryText(it, t)));
  return out;
}

// ---------- แถว ----------
function itemRow(it, { showPlace = false } = {}) {
  const t = today();
  const st = itemState(it, t);
  const p = placeOf(it.place);
  const meta = [...badges(it, t), showPlace ? esc(p.label) : '', it.note ? esc(it.note) : ''].filter(Boolean).join(' · ');
  return `<div class="pt-row ${st}">
    <button type="button" class="pt-main" data-action="pantry:edit" data-id="${esc(it.id)}">
      <span class="pt-emoji" aria-hidden="true">${esc(p.emoji)}</span>
      <span class="pt-body"><span class="pt-name">${esc(it.name)}</span>${meta ? `<span class="pt-meta">${meta}</span>` : ''}</span>
    </button>
    <div class="qty-ctl">
      <button type="button" class="icon-btn sm" data-action="pantry:dec" data-id="${esc(it.id)}" aria-label="ใช้ไป 1" ${it.qty <= 0 ? 'disabled' : ''}>${ICON.minus}</button>
      <b class="qty">${esc(fmtQ(it.qty))}<small>${esc(it.unit || '')}</small></b>
      <button type="button" class="icon-btn sm" data-action="pantry:inc" data-id="${esc(it.id)}" aria-label="เพิ่ม 1">${ICON.plus}</button>
    </div>
  </div>`;
}

function shopRow(kind, x) {
  // kind: auto (ของในบ้านที่ถึงจุดสั่งซื้อ) | manual (เพิ่มเอง)
  const it = kind === 'auto' ? x : x.item_id ? state.items.get(x.item_id) : null;
  const qty = kind === 'auto' ? buyAmount(x) : x.qty;
  const unit = kind === 'auto' ? x.unit : x.unit || (it ? it.unit : '');
  const bits = [];
  if (it) bits.push(it.qty > 0 ? `เหลือ ${fmtQ(it.qty)}${unitOf(it)}` : 'หมดแล้ว');
  if (it && it.shop) bits.push(it.shop);
  if (it && it.price != null) bits.push(`ล่าสุด ${baht(it.price)}`);
  if (kind === 'manual' && x.note) bits.push(x.note);
  return `<div class="shop-row">
    <button type="button" class="tick" data-action="pantry:buy" data-kind="${kind}" data-id="${esc(x.id)}" aria-label="ซื้อแล้ว">${ICON.check}</button>
    <button type="button" class="pt-main" data-action="pantry:${kind === 'auto' ? 'edit' : 'edit-shop'}" data-id="${esc(x.id)}">
      <span class="pt-body"><span class="pt-name">${esc(x.name)}${qty ? ` <span class="muted">× ${esc(fmtQ(qty))}${esc(unit ? ` ${unit}` : '')}</span>` : ''}</span>
      ${bits.length ? `<span class="pt-meta">${esc(bits.join(' · '))}</span>` : ''}</span>
    </button>
    ${kind === 'auto' ? '<span class="auto-tag" title="ขึ้นอัตโนมัติเพราะเหลือถึงจุดสั่งซื้อ">อัตโนมัติ</span>' : ''}
  </div>`;
}

// ---------- หน้า: ของในบ้าน ----------
function viewHome() {
  const t = today();
  const f = state.filter;
  const all = items();
  const q = f.q.toLowerCase();
  const list = all.filter((i) => (!f.place || i.place === f.place) && (!q || `${i.name} ${i.note} ${i.shop}`.toLowerCase().includes(q)));
  const sm = shoppingModel();
  const toBuy = sm.auto.length + sm.manual.length;
  const expiring = all.filter((i) => ['expired', 'expiring'].includes(itemState(i, t))).length;
  const used = new Set(all.map((i) => i.place));
  const order = (a, b) => STATE_ORDER[itemState(a, t)] - STATE_ORDER[itemState(b, t)] || a.name.localeCompare(b.name, 'th');
  const groups = state.places.map((p) => [p, list.filter((i) => i.place === p.key).sort(order)]).filter(([, l]) => l.length);
  const known = new Set(state.places.map((p) => p.key));
  const orphan = list.filter((i) => !known.has(i.place)).sort(order);
  const searchFocused = document.activeElement && document.activeElement.id === 'pantry-q';
  return {
    tab: '',
    title: 'ของในบ้าน',
    body: `
    <section class="month-card stat3" aria-label="สรุป">
      <div><span>ของทั้งหมด</span><b>${all.length}</b></div>
      <div><span>ต้องซื้อ</span><b class="${toBuy ? 'warn' : ''}">${toBuy}</b></div>
      <div><span>ใกล้/หมดอายุ</span><b class="${expiring ? 'bad' : ''}">${expiring}</b></div>
    </section>
    <div class="action-row">
      <button type="button" class="btn primary" data-action="pantry:new-item">+ เพิ่มของ</button>
      <a class="btn" href="#/pantry/shop">🛒 ต้องซื้อ ${toBuy ? `(${toBuy})` : ''}</a>
    </div>
    ${
      all.length
        ? `<input class="in search" id="pantry-q" type="search" placeholder="ค้นหา เช่น นม, ยาสีฟัน" value="${esc(f.q)}" autocomplete="off">
           <div class="chips place-filter">
             <button type="button" class="chip${f.place ? '' : ' on'}" data-action="pantry:filter" data-v="">ทั้งหมด</button>
             ${state.places
               .filter((p) => used.has(p.key))
               .map((p) => `<button type="button" class="chip${f.place === p.key ? ' on' : ''}" data-action="pantry:filter" data-v="${esc(p.key)}">${esc(p.emoji)} ${esc(p.label)}</button>`)
               .join('')}
           </div>`
        : `<div class="hero">
            <p><b>เริ่มจากเพิ่มของที่ใช้ประจำ</b> เช่น นม ไข่ ข้าวสาร ยาสีฟัน กระดาษทิชชู่ — ใส่ว่าเหลือเท่าไร และ "เตือนเมื่อเหลือ" กี่ชิ้น</p>
            <p class="muted">ใช้ไปกด − ซื้อมากด + ของที่เหลือถึงจุดที่ตั้งไว้จะขึ้นในรายการซื้อของให้เอง และใส่วันหมดอายุเพื่อให้เตือนก่อนหมดได้</p>
          </div>`
    }
    ${groups.map(([p, l]) => `<h2 class="sec">${esc(p.emoji)} ${esc(p.label)} <span class="count">${l.length}</span></h2><div class="pt-list">${l.map((i) => itemRow(i)).join('')}</div>`).join('')}
    ${orphan.length ? `<h2 class="sec">อื่น ๆ</h2><div class="pt-list">${orphan.map((i) => itemRow(i)).join('')}</div>` : ''}
    ${all.length && !list.length ? '<p class="empty">ไม่พบของที่ค้นหา</p>' : ''}`,
    after() {
      if (searchFocused) {
        const el = $('#pantry-q');
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    },
  };
}

// ---------- หน้า: ต้องซื้อ ----------
function viewShop() {
  const sm = shoppingModel();
  const open = sm.auto.length + sm.manual.length;
  const est = [...sm.auto, ...sm.manual.map((s) => (s.item_id ? state.items.get(s.item_id) : null)).filter(Boolean)].reduce((s, i) => s + (i.price || 0), 0);
  const names = [...new Set(items().map((i) => i.name))].slice(0, 200);
  return {
    tab: 'shop',
    title: 'รายการซื้อของ',
    actions: open ? `<button type="button" class="btn sm ghost" data-action="pantry:share">${ICON.share} แชร์</button>` : '',
    body: `
    <form class="add-shop" id="pantry-add-shop" autocomplete="off">
      <input class="in" id="ps-name" list="pantry-names" maxlength="120" placeholder="เพิ่มของที่จะซื้อ เช่น ไข่ไก่">
      <input class="in qty-in" id="ps-qty" inputmode="decimal" placeholder="จำนวน" aria-label="จำนวน">
      <button type="submit" class="btn primary">เพิ่ม</button>
      <datalist id="pantry-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    </form>
    ${
      open
        ? `<div class="shop-list">${sm.auto.map((i) => shopRow('auto', i)).join('')}${sm.manual.map((s) => shopRow('manual', s)).join('')}</div>
           <p class="hint">${open} อย่าง${est ? ` · ราคาโดยประมาณจากที่ซื้อล่าสุด ≈ ${esc(baht(est))}` : ''} · กด ✓ เมื่อซื้อแล้ว จำนวนของในบ้านจะเพิ่มให้เอง (ใช้ได้แม้ไม่มีเน็ต)</p>`
        : '<p class="all-clear">✓ ไม่มีของที่ต้องซื้อ</p>'
    }
    ${
      sm.done.length
        ? `<div class="sec-row"><h2 class="sec">ซื้อแล้ว <span class="count">${sm.done.length}</span></h2>
             <button type="button" class="btn sm ghost" data-action="pantry:clear-done">ล้างรายการ</button></div>
           <div class="shop-list done">${sm.done
             .slice(0, 30)
             .map(
               (s) => `<button type="button" class="shop-done" data-action="pantry:edit-shop" data-id="${esc(s.id)}"><span>✓ ${esc(s.name)}${s.qty ? ` × ${esc(fmtQ(s.qty))}${esc(s.unit ? ` ${s.unit}` : '')}` : ''}</span><small>${esc(fmtFull(new Date(s.done_at).toISOString().slice(0, 10)))}</small></button>`
             )
             .join('')}</div>`
        : ''
    }`,
  };
}

// ---------- หน้า: วันหมดอายุ ----------
function viewExpiry() {
  const t = today();
  const list = items()
    .filter((i) => i.expires_on && i.qty > 0)
    .sort((a, b) => a.expires_on.localeCompare(b.expires_on));
  const sections = [
    ['หมดอายุแล้ว', 'overdue', list.filter((i) => expiryLeft(i, t) < 0)],
    ['ภายใน 7 วัน', 'soon', list.filter((i) => expiryLeft(i, t) >= 0 && expiryLeft(i, t) <= 7)],
    ['ภายใน 30 วัน', 'later', list.filter((i) => expiryLeft(i, t) > 7 && expiryLeft(i, t) <= 30)],
    ['หลังจากนั้น', 'later', list.filter((i) => expiryLeft(i, t) > 30)],
  ].filter(([, , l]) => l.length);
  const row = (i, kind) => {
    const d = dateObj(i.expires_on);
    const p = placeOf(i.place);
    return `<div class="due-row ${kind}">
      <button type="button" class="due-main" data-action="pantry:edit" data-id="${esc(i.id)}">
        <span class="due-date"><b>${d.getDate()}</b><span>${esc(F_MON.format(d))}</span></span>
        <span class="due-body"><span class="due-name">${esc(p.emoji)} ${esc(i.name)}</span>
          <span class="due-meta">${esc(expiryText(i, t))} · เหลือ ${esc(fmtQ(i.qty))}${esc(unitOf(i))}</span></span>
      </button>
      <button type="button" class="btn sm ghost" data-action="pantry:used-up" data-id="${esc(i.id)}">หมดแล้ว</button>
    </div>`;
  };
  return {
    tab: 'expiry',
    title: 'วันหมดอายุ',
    body: list.length
      ? sections.map(([title, kind, l]) => `<h2 class="sec ${kind}">${title} <span class="count">${l.length}</span></h2><div class="due-list">${l.map((i) => row(i, kind)).join('')}</div>`).join('')
      : '<p class="empty">ยังไม่มีของที่ใส่วันหมดอายุ — แก้ไขของแล้วใส่ "วันหมดอายุ" เพื่อให้เตือนก่อนหมด</p>',
  };
}

function view(path) {
  if (path === 'shop') return viewShop();
  if (path === 'expiry') return viewExpiry();
  return viewHome();
}

// ---------- หน้า "วันนี้" ----------
function todayCard() {
  const t = today();
  const sm = shoppingModel();
  const names = [...sm.auto.map((i) => i.name), ...sm.manual.map((s) => s.name)];
  const exp = items()
    .filter((i) => ['expired', 'expiring'].includes(itemState(i, t)))
    .sort((a, b) => a.expires_on.localeCompare(b.expires_on));
  if (!names.length && !exp.length) return '';
  return `${
    names.length
      ? `<a class="shop-sum" href="#/pantry/shop"><b>🛒 ต้องซื้อ ${names.length} อย่าง</b><span>${esc(names.slice(0, 6).join(', '))}${names.length > 6 ? ' …' : ''}</span></a>`
      : ''
  }${exp.length ? `<div class="pt-list">${exp.slice(0, 4).map((i) => itemRow(i, { showPlace: true })).join('')}</div>` : ''}`;
}

// ---------- การแก้จำนวน / ซื้อ ----------
function adjust(id, delta) {
  const it = state.items.get(id);
  if (!it) return;
  const wasLow = isLow(it);
  const saved = put('items', { ...it, qty: Math.max(0, Math.round((it.qty + delta) * 100) / 100) });
  rerender();
  if (!wasLow && isLow(saved)) toast(`${saved.name} ${saved.qty > 0 ? 'เหลือน้อยแล้ว' : 'หมดแล้ว'} — ขึ้นในรายการซื้อของ`);
}

function buy(kind, id) {
  const now = Date.now();
  if (kind === 'auto') {
    const it = state.items.get(id);
    if (!it) return;
    const qty = buyAmount(it);
    const before = it;
    put('items', { ...it, qty: Math.round((it.qty + qty) * 100) / 100 });
    const rec = put('shop', { id: uuid(), item_id: it.id, name: it.name, qty, unit: it.unit, note: '', done_at: now });
    rerender();
    toast(`ซื้อแล้ว: ${it.name} +${fmtQ(qty)}${unitOf(it)}`, {
      label: 'เลิกทำ',
      fn: () => {
        put('items', { ...before });
        del('shop', rec.id);
        rerender();
      },
    });
    return;
  }
  const s = state.shop.get(id);
  if (!s) return;
  const it = s.item_id ? state.items.get(s.item_id) : null;
  const before = it ? { ...it } : null;
  const qty = s.qty || (it ? buyAmount(it) : null);
  if (it) put('items', { ...it, qty: Math.round((it.qty + (qty || 1)) * 100) / 100 });
  put('shop', { ...s, qty: s.qty ?? qty, done_at: now });
  rerender();
  toast(`ซื้อแล้ว: ${s.name}${it ? ` (มีอยู่ ${fmtQ(state.items.get(it.id).qty)}${unitOf(it)})` : ''}`, {
    label: 'เลิกทำ',
    fn: () => {
      if (before) put('items', before);
      put('shop', { ...s, done_at: null });
      rerender();
    },
  });
}

function addShop(name, qty) {
  const key = name.trim().toLowerCase();
  const it = items().find((i) => i.name.toLowerCase() === key);
  const open = shopList().find((s) => !s.done_at && (it ? s.item_id === it.id : s.name.toLowerCase() === key));
  if (open) return toast(`${open.name} อยู่ในรายการแล้ว`);
  if (it && isLow(it) && qty == null) return toast(`${it.name} อยู่ในรายการแล้ว (เหลือถึงจุดสั่งซื้อ)`);
  put('shop', { id: uuid(), item_id: it ? it.id : null, name: it ? it.name : name.trim(), qty, unit: it ? it.unit : '', note: '', done_at: null });
  rerender();
  toast(`เพิ่ม ${it ? it.name : name.trim()} ในรายการซื้อแล้ว`);
}

function shareList() {
  const sm = shoppingModel();
  const lines = [
    ...sm.auto.map((i) => `• ${i.name} ${fmtQ(buyAmount(i))}${unitOf(i)}`),
    ...sm.manual.map((s) => `• ${s.name}${s.qty ? ` ${fmtQ(s.qty)}${s.unit ? ` ${s.unit}` : ''}` : ''}${s.note ? ` (${s.note})` : ''}`),
  ];
  const text = `รายการซื้อของ (${fmtFull(today())})\n${lines.join('\n')}`;
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast('คัดลอกรายการแล้ว — วางใน LINE หรือแชตได้เลย'),
      () => toast('คัดลอกไม่สำเร็จ')
    );
  }
}

// ---------- แผ่น: ของในบ้าน ----------
let mode = null; // 'item' | 'shop'
let X = null;

const val = (sel) => {
  const el = $(sel, sheetEl);
  return el ? el.value.trim() : '';
};

function openItem(item, preset) {
  mode = 'item';
  X = item
    ? { ...item, isNew: false }
    : { id: uuid(), name: '', place: state.filter.place || 'other', qty: 1, unit: '', min_qty: null, buy_qty: null, expires_on: null, remind_days: 3, price: null, shop: '', note: '', isNew: true, ...(preset || {}) };
  renderItemSheet();
}

function readItemForm() {
  X.name = val('#i-name');
  X.qty = parseNum(val('#i-qty')) ?? 0;
  X.unit = val('#i-unit');
  X.min_qty = parseNum(val('#i-min'));
  X.buy_qty = parseNum(val('#i-buy'));
  X.expires_on = val('#i-exp') || null;
  X.price = parseNum(val('#i-price'));
  X.shop = val('#i-shop');
  X.note = val('#i-note');
}

function renderItemSheet() {
  const x = X;
  const t = today();
  const places = state.places.filter((p) => !p.hidden || p.key === x.place);
  const shops = [...new Set(items().map((i) => i.shop).filter(Boolean))].slice(0, 20);
  const exists = new Set(items().map((i) => i.name));
  const presets = PRESETS.filter(([n]) => !exists.has(n));
  openSheet(`
    <form class="sheet-body" id="pantry-item-form" novalidate>
      ${sheetHead(x.isNew ? 'เพิ่มของในบ้าน' : 'แก้ไขของ')}
      <div class="field"><label for="i-name">ชื่อ *</label>
        <input id="i-name" maxlength="120" value="${esc(x.name)}" placeholder="เช่น นมจืด, ไข่ไก่, ยาสีฟัน" autocomplete="off">
        ${x.isNew && presets.length ? `<div class="chips">${presets.slice(0, 10).map(([n]) => `<button type="button" class="chip soft" data-x="preset" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><span class="label">เก็บที่</span>
        <div class="chips">${places.map((p) => `<button type="button" class="chip${x.place === p.key ? ' on' : ''}" data-x="place" data-v="${esc(p.key)}">${esc(p.emoji)} ${esc(p.label)}</button>`).join('')}</div>
      </div>
      <div class="field two">
        <div><label for="i-qty">มีอยู่</label>
          <div class="stepper"><button type="button" class="icon-btn sm" data-x="step" data-v="-1" aria-label="ลด">${ICON.minus}</button>
          <input id="i-qty" class="in" inputmode="decimal" value="${esc(fmtQ(x.qty))}"><button type="button" class="icon-btn sm" data-x="step" data-v="1" aria-label="เพิ่ม">${ICON.plus}</button></div></div>
        <div><label for="i-unit">หน่วย</label><input id="i-unit" class="in" maxlength="20" list="pantry-units" value="${esc(x.unit)}" placeholder="ชิ้น"></div>
      </div>
      <datalist id="pantry-units">${UNITS.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
      <div class="field two">
        <div><label for="i-min">เตือนให้ซื้อเมื่อเหลือ</label><input id="i-min" class="in" inputmode="decimal" value="${x.min_qty ?? ''}" placeholder="ไม่เตือน"></div>
        <div><label for="i-buy">ปกติซื้อครั้งละ</label><input id="i-buy" class="in" inputmode="decimal" value="${x.buy_qty ?? ''}" placeholder="1"></div>
      </div>
      <p class="hint">เหลือเท่ากับหรือน้อยกว่าที่ตั้งไว้ จะขึ้นใน "ต้องซื้อ" ให้เอง (ใส่ 0 = ขึ้นเมื่อหมด)</p>
      <div class="field"><label for="i-exp">วันหมดอายุ <small>(ของชิ้นที่ใกล้หมดที่สุด)</small></label>
        <input id="i-exp" type="date" value="${esc(x.expires_on || '')}">
        <div class="chips">
          ${[
            [3, '+3 วัน'],
            [7, '+7 วัน'],
            [30, '+1 เดือน'],
            [90, '+3 เดือน'],
            [365, '+1 ปี'],
          ]
            .map(([d, l]) => `<button type="button" class="chip soft" data-x="exp" data-v="${addDays(t, d)}">${l}</button>`)
            .join('')}
          <button type="button" class="chip soft" data-x="exp" data-v="">ไม่มี</button>
        </div>
        <div class="chips">${[1, 3, 7, 30]
          .map((d) => `<button type="button" class="chip${x.remind_days === d ? ' on' : ''}" data-x="remind" data-v="${d}">เตือน ${d} วันก่อน</button>`)
          .join('')}</div>
      </div>
      <div class="field two">
        <div><label for="i-price">ราคาที่ซื้อล่าสุด (บาท)</label><input id="i-price" class="in" inputmode="decimal" value="${x.price ?? ''}"></div>
        <div><label for="i-shop">ซื้อที่</label><input id="i-shop" class="in" maxlength="80" list="pantry-shops" value="${esc(x.shop)}" placeholder="เช่น Lotus's, 7-Eleven"></div>
      </div>
      <datalist id="pantry-shops">${shops.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="field"><label for="i-note">หมายเหตุ</label><input id="i-note" maxlength="500" value="${esc(x.note)}" placeholder="เช่น ยี่ห้อที่ชอบ, ขนาด"></div>
      <div class="sheet-actions wrap">
        ${x.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="del">ลบ</button><button type="button" class="btn ghost" data-x="to-shop">+ ใส่ในรายการซื้อ</button>'}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
}

function submitItem() {
  readItemForm();
  if (!X.name) return toast('กรุณาใส่ชื่อ');
  if ([X.qty, X.min_qty, X.buy_qty, X.price].some(Number.isNaN)) return toast('ตัวเลขไม่ถูกต้อง');
  const dup = X.isNew && items().find((i) => i.name.toLowerCase() === X.name.toLowerCase());
  if (dup && !confirm(`มี "${dup.name}" อยู่แล้ว เพิ่มซ้ำอีกรายการไหม? (ถ้าจะเพิ่มจำนวน ให้กด + ที่รายการเดิม)`)) return;
  const wasNew = X.isNew;
  const saved = put('items', X);
  closeSheet();
  rerender();
  toast(wasNew ? `เพิ่ม ${saved.name} แล้ว` : 'บันทึกแล้ว');
}

// ---------- แผ่น: รายการซื้อที่เพิ่มเอง ----------
function openShop(entry) {
  mode = 'shop';
  X = entry ? { ...entry, isNew: false } : { id: uuid(), item_id: null, name: '', qty: null, unit: '', note: '', done_at: null, isNew: true };
  renderShopSheet();
}

function renderShopSheet() {
  const x = X;
  const it = x.item_id ? state.items.get(x.item_id) : null;
  openSheet(`
    <form class="sheet-body" id="pantry-shop-form" novalidate>
      ${sheetHead(x.isNew ? 'เพิ่มของที่จะซื้อ' : x.done_at ? 'ซื้อแล้ว' : 'ของที่จะซื้อ')}
      <div class="field"><label for="s-name">ซื้ออะไร *</label>
        <input id="s-name" maxlength="120" list="pantry-names2" value="${esc(x.name)}" ${it ? 'readonly' : ''} placeholder="เช่น ไข่ไก่" autocomplete="off">
        <datalist id="pantry-names2">${items().map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
        ${it ? `<p class="hint">ผูกกับของในบ้าน: เหลือ ${esc(fmtQ(it.qty))}${esc(unitOf(it))} — กด ✓ ซื้อแล้ว จำนวนจะเพิ่มให้เอง</p>` : ''}
      </div>
      <div class="field two">
        <div><label for="s-qty">จำนวน</label><input id="s-qty" class="in" inputmode="decimal" value="${x.qty ?? ''}"></div>
        <div><label for="s-unit">หน่วย</label><input id="s-unit" class="in" maxlength="20" list="pantry-units2" value="${esc(x.unit)}"></div>
      </div>
      <datalist id="pantry-units2">${UNITS.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
      <div class="field"><label for="s-note">หมายเหตุ</label><input id="s-note" maxlength="300" value="${esc(x.note)}" placeholder="เช่น ยี่ห้อ, ขนาด, ร้าน"></div>
      <div class="sheet-actions wrap">
        ${x.isNew ? '' : '<button type="button" class="btn ghost danger" data-x="del">ลบ</button>'}
        ${!x.isNew && x.done_at ? '<button type="button" class="btn ghost" data-x="undone">ยังไม่ได้ซื้อ</button>' : ''}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
}

function submitShop() {
  const name = val('#s-name');
  const qty = parseNum(val('#s-qty'));
  if (!name) return toast('กรุณาใส่ว่าซื้ออะไร');
  if (Number.isNaN(qty)) return toast('จำนวนไม่ถูกต้อง');
  let item_id = X.item_id;
  if (!item_id) {
    const it = items().find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (it) item_id = it.id;
  }
  const wasNew = X.isNew;
  put('shop', { ...X, item_id, name, qty, unit: val('#s-unit'), note: val('#s-note') });
  closeSheet();
  rerender();
  toast(wasNew ? `เพิ่ม ${name} ในรายการซื้อแล้ว` : 'บันทึกแล้ว');
}

const sheet = {
  click(ev, b, x) {
    if (mode === 'item' && X) {
      if (x === 'preset') {
        readItemForm();
        const p = PRESETS.find((r) => r[0] === b.dataset.v);
        if (p) Object.assign(X, { name: p[0], place: p[1], unit: p[2], min_qty: p[3], buy_qty: p[4] });
        renderItemSheet();
      } else if (x === 'place') {
        X.place = b.dataset.v;
        for (const c of sheetEl.querySelectorAll('[data-x="place"]')) c.classList.toggle('on', c.dataset.v === X.place);
      } else if (x === 'step') {
        const el = $('#i-qty', sheetEl);
        const n = parseNum(el.value) || 0;
        el.value = fmtQ(Math.max(0, n + Number(b.dataset.v)));
      } else if (x === 'exp') {
        $('#i-exp', sheetEl).value = b.dataset.v;
      } else if (x === 'remind') {
        X.remind_days = Number(b.dataset.v);
        for (const c of sheetEl.querySelectorAll('[data-x="remind"]')) c.classList.toggle('on', Number(c.dataset.v) === X.remind_days);
      } else if (x === 'del') {
        if (!confirm(`ลบ "${X.name}" ออกจากของในบ้าน?`)) return;
        const old = del('items', X.id);
        closeSheet();
        rerender();
        toast('ลบแล้ว', { label: 'เลิกทำ', fn: () => (put('items', old), rerender()) });
      } else if (x === 'to-shop') {
        const it = X;
        closeSheet();
        addShop(it.name, buyAmount(it));
      }
    } else if (mode === 'shop' && X) {
      if (x === 'del') {
        const old = del('shop', X.id);
        closeSheet();
        rerender();
        toast('ลบแล้ว', { label: 'เลิกทำ', fn: () => (put('shop', old), rerender()) });
      } else if (x === 'undone') {
        put('shop', { ...X, done_at: null });
        closeSheet();
        rerender();
      }
    }
  },
  submit(ev) {
    if (ev.target.id === 'pantry-item-form' && mode === 'item') submitItem();
    else if (ev.target.id === 'pantry-shop-form' && mode === 'shop') submitShop();
  },
  closed() {
    mode = X = null;
  },
};

// ---------- ตั้งค่า / สำรอง ----------
const cats = new CatEditor({ mod: ID, path: '/categories', noun: 'ที่เก็บ' });

function settings() {
  return `<h3>ที่เก็บของ</h3>
    <p class="hint">แก้ไอคอน ชื่อ ลำดับ หรือซ่อนที่เก็บที่ไม่ใช้</p>
    ${cats.html(state.places)}
    <div class="row"><button type="button" class="btn ghost" data-action="pantry:export-csv">ส่งออกรายการของในบ้าน (CSV)</button></div>`;
}

function toCSV() {
  const rows = [['ชื่อ', 'ที่เก็บ', 'มีอยู่', 'หน่วย', 'เตือนเมื่อเหลือ', 'ซื้อครั้งละ', 'วันหมดอายุ', 'ราคาล่าสุด', 'ซื้อที่', 'หมายเหตุ']];
  for (const i of items().sort((a, b) => a.name.localeCompare(b.name, 'th'))) {
    rows.push([i.name, placeOf(i.place).label, i.qty, i.unit, i.min_qty ?? '', i.buy_qty ?? '', i.expires_on || '', i.price ?? '', i.shop, i.note]);
  }
  return csv(rows);
}

async function exportData() {
  const d = await api('/api/pantry/data');
  return { places: d.places, items: d.items, shop: d.shop };
}

async function importData(data) {
  const its = Array.isArray(data && data.items) ? data.items : [];
  const shop = Array.isArray(data && data.shop) ? data.shop : [];
  if (!its.length && !shop.length) return '';
  if (!confirm(`ของในบ้าน: นำเข้าของ ${its.length} รายการ และรายการซื้อ ${shop.length} รายการ?`)) return '';
  const ops = [...its.map((item) => ({ mod: ID, table: 'items', type: 'put', item })), ...shop.map((item) => ({ mod: ID, table: 'shop', type: 'put', item }))];
  let rejected = 0;
  for (let i = 0; i < ops.length; i += 200) {
    const r = await api('/api/sync', { method: 'POST', body: { ops: ops.slice(i, i + 200) } });
    rejected += r.rejected.length;
  }
  if (Array.isArray(data.places) && confirm('ในไฟล์มีที่เก็บของด้วย ต้องการใช้จากไฟล์ไหม?')) {
    await api('/api/pantry/categories', { method: 'PUT', body: { categories: data.places } });
    cats.edit = null;
  }
  return `ของ ${its.length} · รายการซื้อ ${shop.length}${rejected ? ` (ข้าม ${rejected})` : ''}`;
}

// ---------- actions ----------
const actions = {
  'new-item': () => openItem(null),
  edit: (b) => {
    const it = state.items.get(b.dataset.id);
    if (it) openItem(it);
  },
  'edit-shop': (b) => {
    const s = state.shop.get(b.dataset.id);
    if (s) openShop(s);
  },
  'new-shop': () => openShop(null),
  inc: (b) => adjust(b.dataset.id, 1),
  dec: (b) => adjust(b.dataset.id, -1),
  buy: (b) => buy(b.dataset.kind, b.dataset.id),
  'used-up': (b) => {
    const it = state.items.get(b.dataset.id);
    if (!it) return;
    const before = { ...it };
    put('items', { ...it, qty: 0, expires_on: null });
    rerender();
    toast(`${it.name} — ทำเครื่องหมายว่าหมดแล้ว`, { label: 'เลิกทำ', fn: () => (put('items', before), rerender()) });
  },
  filter: (b) => {
    state.filter.place = b.dataset.v;
    rerender();
  },
  share: () => shareList(),
  'clear-done': () => {
    const done = shopList().filter((s) => s.done_at);
    for (const s of done) del('shop', s.id);
    rerender();
    toast(`ล้าง ${done.length} รายการแล้ว`);
  },
  'export-csv': () => download(`pantry_${today()}.csv`, toCSV(), 'text/csv;charset=utf-8'),
};
for (const name of ['cat-add', 'cat-up', 'cat-down', 'cat-save', 'cat-reset']) {
  actions[name] = (b) =>
    cats.handle(name, b, {
      api,
      toast,
      handleErr,
      saved: (c) => {
        state.places = c;
        saveCache();
        rerender();
      },
    });
}

let searchTimer;
const mod = {
  id: ID,
  label: 'ของในบ้าน',
  short: 'ของในบ้าน',
  emoji: '🧺',
  icon: 'basket',
  about: 'ของใกล้หมด รายการซื้อของ วันหมดอายุ',
  tabs: [
    ['', 'ของในบ้าน'],
    ['shop', 'ต้องซื้อ'],
    ['expiry', 'วันหมดอายุ'],
  ],
  quick: [{ label: 'ของที่ต้องซื้อ', action: 'pantry:new-shop' }],
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
  settingsHint: 'ที่เก็บของ ส่งออก CSV',
  exportData,
  importData,
  onInput(ev) {
    if (ev.target.id === 'pantry-q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.q = ev.target.value.trim();
        rerender();
      }, 250);
    }
  },
  onSubmit(ev) {
    if (ev.target.id !== 'pantry-add-shop') return;
    const nameEl = $('#ps-name');
    const qtyEl = $('#ps-qty');
    const name = nameEl.value.trim();
    const qty = parseNum(qtyEl.value);
    if (!name) return nameEl.focus();
    if (Number.isNaN(qty)) return toast('จำนวนไม่ถูกต้อง');
    addShop(name, qty);
    const n = $('#ps-name');
    if (n) n.focus();
  },
  leave() {
    cats.edit = null;
  },
  deepLink(params) {
    const add = params.get('add');
    if (add === 'pantry') openShop(null);
    else if (add === 'pantry:item') openItem(null);
    else return false;
    return true;
  },
  reset() {
    store.del(CACHE);
    state.items = new Map();
    state.shop = new Map();
    cats.edit = null;
  },
};
export default mod;
