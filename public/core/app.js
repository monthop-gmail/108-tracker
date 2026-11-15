/* 108 Tracker — โครงหลักของหน้าเว็บ (ES module, ไม่ต้อง build)
 * - ล็อกอิน, เมนูล่าง, หน้า "วันนี้" ที่รวมทุกโมดูล, หน้าตั้งค่า, การแจ้งเตือน, สำรองข้อมูล
 * - outbox กลาง: บันทึกจากทุกโมดูลเก็บลงเครื่องก่อน แล้วส่งขึ้น /api/sync → ใช้ได้แม้เน็ตหลุด
 * - แต่ละโมดูลอยู่ใน /modules/<id>/index.js และประกาศสิ่งเดียวกัน (ดู README หัวข้อ "เพิ่มโมดูลใหม่")
 */
import { $, $$, esc, pad, store, today, F_LONG, ICON, download } from './util.js';
import health from '../modules/health/index.js';
import bills from '../modules/bills/index.js';
import maint from '../modules/maint/index.js';
import pantry from '../modules/pantry/index.js';

/** ลำดับนี้คือลำดับในเมนูและหน้า "วันนี้" — เพิ่มโมดูลใหม่ที่นี่ (และใน src/index.ts) */
const ALL = [health, bills, maint, pantry];
const BY_ID = new Map(ALL.map((m) => [m.id, m]));

const app = $('#app');
const sheetEl = $('#sheet');
const toastEl = $('#toast');

const state = {
  authed: null,
  online: true,
  syncing: false,
  lastRefresh: 0,
  enabled: store.get('t108_modules', ALL.map((m) => m.id)),
  route: { mod: null, path: '' },
  outbox: store.get('t108_outbox', []),
  seq: store.get('t108_seq', 0),
};
const enabledMods = () => ALL.filter((m) => state.enabled.includes(m.id));

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('network');
    err.network = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `http_${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/** จัดการ error ทั่วไป (หลุดล็อกอิน / ออฟไลน์) — คืน true ถ้าจัดการแล้ว */
function handleErr(e) {
  if (e.status === 401) {
    showLogin();
    return true;
  }
  if (e.network) {
    state.online = false;
    updateSync();
    return true;
  }
  return false;
}

// ---------- outbox / sync ----------
const opKey = (o) => `${o.mod}:${o.table || ''}:${o.type === 'put' ? o.item.id : o.id}`;
const persistOutbox = () => {
  store.set('t108_outbox', state.outbox);
  store.set('t108_seq', state.seq);
};

/** เพิ่มคำสั่งเข้าคิว (ทับคำสั่งเดิมของรายการเดียวกัน) แล้วส่งเบื้องหลัง */
function queue(op) {
  const k = opKey(op);
  state.outbox = state.outbox.filter((o) => opKey(o) !== k);
  op.seq = ++state.seq;
  state.outbox.push(op);
  persistOutbox();
  updateSync();
  setTimeout(flush, 0);
}

/** id ที่ยังรอส่ง (สำหรับแสดง ⏳) */
const pendingIds = (mod, table) =>
  new Set(state.outbox.filter((o) => o.mod === mod && (o.table || '') === (table || '') && o.type === 'put').map((o) => o.item.id));

/** ทับข้อมูลจากเซิร์ฟเวอร์ด้วยคำสั่งที่ยังค้างส่ง (กันรายการที่เพิ่งบันทึกหายตอนโหลดใหม่) */
function applyOutbox(mod, table, map) {
  for (const o of state.outbox) {
    if (o.mod !== mod || (o.table || '') !== (table || '')) continue;
    if (o.type === 'put') map.set(o.item.id, o.item);
    else map.delete(o.id);
  }
}

async function flush() {
  if (state.syncing || !state.outbox.length || state.authed !== true) return;
  state.syncing = true;
  updateSync();
  const batch = state.outbox.slice(0, 200);
  let again = false;
  try {
    const r = await api('/api/sync', { method: 'POST', body: { ops: batch.map(({ seq, ...o }) => o) } });
    const sent = new Set(batch.map((o) => o.seq));
    state.outbox = state.outbox.filter((o) => !sent.has(o.seq));
    persistOutbox();
    state.online = true;
    if (r.rejected && r.rejected.length) toast(`มี ${r.rejected.length} รายการที่ระบบไม่รับ (ข้อมูลไม่ถูกต้อง)`);
    again = state.outbox.length > 0;
  } catch (e) {
    if (e.status === 400) {
      const sent = new Set(batch.map((o) => o.seq));
      state.outbox = state.outbox.filter((o) => !sent.has(o.seq));
      persistOutbox();
      toast('ส่งข้อมูลบางส่วนไม่สำเร็จ');
    } else handleErr(e);
  } finally {
    state.syncing = false;
    updateSync();
    // อัปเดตเครื่องหมาย ⏳ (ไม่วาดใหม่ถ้ากำลังพิมพ์ในหน้า)
    const a = document.activeElement;
    if (!(a && app.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) rerender();
  }
  if (again) flush();
}

// ---------- UI ทั่วไป ----------
let toastTimer;
function toast(msg, action) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  toastEl.hidden = false;
  if (action) {
    $('button', toastEl).onclick = () => {
      toastEl.hidden = true;
      action.fn();
    };
  }
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 2600);
}

function updateSync() {
  const n = state.outbox.length;
  let cls = '';
  let txt = '';
  if (!state.online) {
    cls = 'off';
    txt = n ? `ออฟไลน์ · รอส่ง ${n} รายการ (บันทึกไว้ในเครื่องแล้ว)` : 'ออฟไลน์ — ยังบันทึกได้ตามปกติ';
  } else if (n) {
    cls = 'wait';
    txt = state.syncing ? `กำลังส่ง ${n} รายการ…` : `รอส่ง ${n} รายการ`;
  }
  for (const el of $$('.sync')) {
    el.className = `sync ${cls}`;
    el.textContent = txt;
    el.hidden = !txt;
  }
  const p = $('#pending-count');
  if (p) p.textContent = String(n);
}

// ---------- แผ่น (bottom sheet) ----------
let sheetOwner = null;
function openSheet(mod, html) {
  sheetOwner = mod;
  sheetEl.innerHTML = html;
  if (!sheetEl.open) sheetEl.showModal();
}
function closeSheet() {
  if (sheetEl.open) sheetEl.close();
}
sheetEl.addEventListener('close', () => {
  const o = sheetOwner;
  sheetOwner = null;
  o?.sheet?.closed?.();
});
sheetEl.addEventListener('click', (ev) => {
  if (ev.target === sheetEl) return closeSheet();
  // ปุ่มของโมดูลที่อยู่ในแผ่น (เช่น แถวการจ่ายในรายละเอียดรายการ)
  const a = ev.target.closest('[data-action]');
  if (a && !a.disabled && dispatch(a.dataset.action, a, ev)) return;
  const b = ev.target.closest('[data-x]');
  if (!b) return;
  if (b.dataset.x === 'close') return closeSheet();
  sheetOwner?.sheet?.click?.(ev, b, b.dataset.x);
});
sheetEl.addEventListener('input', (ev) => sheetOwner?.sheet?.input?.(ev));
sheetEl.addEventListener('keydown', (ev) => sheetOwner?.sheet?.keydown?.(ev));
sheetEl.addEventListener('change', (ev) => sheetOwner?.sheet?.change?.(ev));
sheetEl.addEventListener('submit', (ev) => {
  ev.preventDefault();
  sheetOwner?.sheet?.submit?.(ev);
});

// ---------- บริบทที่ส่งให้โมดูล ----------
const ctx = {
  api,
  toast,
  handleErr,
  queue: (mod, op) => queue({ mod, ...op }),
  pendingIds,
  applyOutbox,
  openSheet,
  closeSheet,
  sheetEl,
  rerender: () => rerender(),
  isOn: (mod, path) => state.route.mod === mod && (path === undefined || state.route.path === path),
  get online() {
    return state.online;
  },
};
for (const m of ALL) m.init(ctx);

// ---------- เมนูล่าง ----------
function tabbar() {
  const mods = enabledMods();
  const cur = state.route.mod;
  let items = [['', 'วันนี้', ICON.home, cur === null]];
  const show = mods.length > 4 ? mods.slice(0, 3) : mods;
  for (const m of show) items.push([m.id, m.short || m.label, ICON[m.icon], cur === m.id]);
  if (mods.length > 4) items.push(['more', 'เพิ่มเติม', ICON.more, cur === 'more' || (cur && !show.some((m) => m.id === cur) && cur !== 'settings')]);
  return `<nav class="tabbar n${items.length} no-print" aria-label="เมนูหลัก">${items
    .map(([id, label, icon, on]) => `<a href="#/${id}" data-tab="${id || 'home'}" class="${on ? 'on' : ''}"${on ? ' aria-current="page"' : ''}>${icon}<span>${esc(label)}</span></a>`)
    .join('')}</nav>`;
}

function subtabs(mod, tab) {
  if (!mod.tabs || mod.tabs.length < 2) return '';
  return `<nav class="subtabs no-print" aria-label="${esc(mod.label)}">${mod.tabs
    .map(([p, label]) => `<a href="#/${mod.id}${p ? `/${p}` : ''}" class="${tab === p ? 'on' : ''}"${tab === p ? ' aria-current="page"' : ''}>${esc(label)}</a>`)
    .join('')}</nav>`;
}

// ---------- วาดหน้า ----------
function rerender() {
  if (state.authed === false) return;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function render() {
  const r = state.route;
  document.body.dataset.mod = r.mod && BY_ID.has(r.mod) ? r.mod : 'home';
  if (r.mod === 'settings') return renderSettings();
  if (r.mod === 'more') return renderMore();
  if (!r.mod) return renderToday();
  const mod = BY_ID.get(r.mod);
  const v = mod.view(r.path);
  app.innerHTML = `
    <header class="topbar">
      ${v.back ? `<a class="icon-btn plain" href="${esc(v.back)}" aria-label="กลับ">${ICON.back}</a>` : ''}
      <div class="brand grow">${v.eyebrow ? `<div class="eyebrow">${esc(v.eyebrow)}</div>` : ''}<h1>${v.title}</h1></div>
      ${v.actions || ''}
    </header>
    ${v.tab != null ? subtabs(mod, v.tab) : ''}
    <div class="sync" hidden></div>
    ${v.body}
    ${tabbar()}`;
  v.after?.();
  updateSync();
}

function renderToday() {
  const mods = enabledMods();
  const quick = mods.flatMap((m) => (m.quick || []).map((q) => ({ ...q, mod: m })));
  const cards = mods
    .map((m) => {
      let body = '';
      try {
        body = m.today();
      } catch (e) {
        console.error(e);
      }
      return `<section class="today-card" data-mod="${m.id}">
        <div class="tc-head"><a href="#/${m.id}" class="tc-title"><span aria-hidden="true">${m.emoji}</span> ${esc(m.label)}</a><a class="tc-more" href="#/${m.id}">เปิด →</a></div>
        ${body || '<p class="tc-empty">ไม่มีเรื่องค้าง ✓</p>'}
      </section>`;
    })
    .join('');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><div class="eyebrow">${esc(F_LONG.format(new Date()))}</div><h1>วันนี้</h1></div>
      <a class="icon-btn" href="#/settings" aria-label="ตั้งค่า">${ICON.settings}</a>
    </header>
    <div class="sync" hidden></div>
    ${quick.length ? `<div class="quick-actions">${quick.map((q) => `<button type="button" class="qa" data-mod="${q.mod.id}" data-action="${esc(q.action)}"><span aria-hidden="true">${q.mod.emoji}</span>${esc(q.label)}</button>`).join('')}</div>` : ''}
    ${cards}
    ${tabbar()}`;
  for (const m of mods) m.todayAfter?.();
  updateSync();
}

function renderMore() {
  app.innerHTML = `
    <header class="topbar"><div class="brand"><h1>ทั้งหมด</h1></div></header>
    <div class="sync" hidden></div>
    <div class="mod-grid">${enabledMods()
      .map((m) => `<a class="mod-tile" data-mod="${m.id}" href="#/${m.id}"><span class="mt-emoji" aria-hidden="true">${m.emoji}</span><b>${esc(m.label)}</b></a>`)
      .join('')}
      <a class="mod-tile" href="#/settings"><span class="mt-emoji" aria-hidden="true">⚙️</span><b>ตั้งค่า</b></a></div>
    ${tabbar()}`;
  updateSync();
}

// ---------- ล็อกอิน ----------
function showLogin() {
  state.authed = false;
  if (sheetEl.open) sheetEl.close();
  renderLogin();
}

function renderLogin(msg = '') {
  document.body.dataset.mod = 'home';
  app.innerHTML = `
    <main class="login">
      <div class="login-card">
        <img src="/icon.svg" alt="">
        <h1>108 Tracker</h1>
        <p>ใส่รหัสผ่านเพื่อเข้าใช้งาน</p>
        <form id="login-form">
          <input class="in" type="password" name="password" autocomplete="current-password" placeholder="รหัสผ่าน" required autofocus>
          <button class="btn primary" type="submit">เข้าสู่ระบบ</button>
          <p class="err" id="login-err">${esc(msg)}</p>
        </form>
      </div>
    </main>`;
}

async function doLogin(form) {
  const btn = $('button', form);
  const err = $('#login-err');
  btn.disabled = true;
  err.textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: form.password.value } });
    state.authed = true;
    state.online = true;
    await afterAuth();
  } catch (e) {
    const m = {
      wrong_password: 'รหัสผ่านไม่ถูกต้อง',
      too_many_attempts: 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
      password_not_configured: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสผ่าน หรือรหัสผ่านสั้นเกินไป (APP_PASSWORD ต้องยาวอย่างน้อย 8 ตัว)',
    };
    err.textContent = e.network ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' : m[e.code] || 'เข้าสู่ระบบไม่สำเร็จ';
    btn.disabled = false;
    form.password.select();
  }
}

// ---------- โหลดข้อมูล ----------
async function refreshAll() {
  state.lastRefresh = Date.now();
  try {
    const me = await api('/api/me');
    if (Array.isArray(me.modules) && me.modules.length) {
      state.enabled = me.modules;
      store.set('t108_modules', me.modules);
    }
  } catch (e) {
    handleErr(e);
    return;
  }
  const res = await Promise.allSettled(enabledMods().map((m) => m.refresh()));
  const fail = res.find((r) => r.status === 'rejected');
  if (fail) handleErr(fail.reason);
  else state.online = true;
  if (state.route.mod && !['settings', 'more'].includes(state.route.mod) && !state.enabled.includes(state.route.mod)) location.hash = '#/';
  else rerender();
}

// ---------- ตั้งค่า ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Asia/Bangkok';
  }
};
const keyBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameKey = (buf, b64) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  const b = keyBytes(b64);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

// ส่วนตั้งค่าของโมดูลที่เปิดอยู่ (คงไว้เมื่อวาดหน้าใหม่)
const openSettings = new Set();
app.addEventListener(
  'toggle',
  (ev) => {
    const d = ev.target;
    if (d.matches && d.matches('details.mod-settings')) d.open ? openSettings.add(d.dataset.mod) : openSettings.delete(d.dataset.mod);
  },
  true
);

function renderSettings() {
  let push;
  if (!pushSupported()) {
    push =
      isIOS() && !isStandalone()
        ? '<p class="hint warn-box">บน iPhone/iPad ต้อง <b>เพิ่มแอปไปที่หน้าจอโฮม</b> ก่อน (ปุ่มแชร์ → เพิ่มไปยังหน้าจอโฮม) แล้วเปิดจากไอคอนนั้น จึงจะเปิดการแจ้งเตือนได้</p>'
        : '<p class="hint warn-box">เบราว์เซอร์นี้ยังไม่รองรับการแจ้งเตือน ลองใช้ Chrome บน Android หรือคอมพิวเตอร์</p>';
  } else {
    push = `<p class="hint" id="push-status">กำลังตรวจสอบ…</p>
      <div class="row">
        <button type="button" class="btn primary" data-action="push-on" id="push-on" hidden>เปิดการแจ้งเตือนบนเครื่องนี้</button>
        <button type="button" class="btn" data-action="push-test" id="push-test" hidden>ส่งทดสอบ</button>
        <button type="button" class="btn" data-action="push-digest" id="push-digest" hidden>ส่งสรุปตอนนี้</button>
        <button type="button" class="btn ghost" data-action="push-off" id="push-off" hidden>ปิดบนเครื่องนี้</button>
      </div>`;
  }
  const mods = enabledMods();
  app.innerHTML = `
    <header class="topbar"><a class="icon-btn plain" href="#/" aria-label="กลับ">${ICON.back}</a><div class="brand grow"><h1>ตั้งค่า</h1></div></header>
    <div class="sync" hidden></div>
    <section class="card">
      <h2>การแจ้งเตือน</h2>
      <p class="hint">เปิดครั้งเดียวใช้ได้ทุกโมดูล — เตือนยาตามมื้อและนัดหมอตามเวลา และส่ง<b>สรุปประจำวัน</b>รวมเรื่องที่ต้องจ่าย ต้องดูแล และของที่ต้องซื้อ/ใกล้หมดอายุ (เปิดได้หลายเครื่อง)</p>
      <div class="field inline"><label for="digest-hour">เวลาส่งสรุปประจำวัน</label>
        <select id="digest-hour" class="in">${Array.from({ length: 18 }, (_, i) => i + 5)
          .map((h) => `<option value="${h}">${pad(h)}:00</option>`)
          .join('')}</select></div>
      ${push}
    </section>
    <section class="card">
      <h2>โมดูลที่ใช้</h2>
      <p class="hint">ปิดโมดูลที่ไม่ใช้ได้ (ข้อมูลไม่หาย เปิดกลับมาเมื่อไรก็ได้) — โมดูลที่ปิดจะไม่แสดงและไม่เตือน</p>
      <div class="mod-toggles">${ALL.map(
        (m) => `<label class="check big"><input type="checkbox" data-mod-toggle="${m.id}" ${state.enabled.includes(m.id) ? 'checked' : ''}> <span>${m.emoji} ${esc(m.label)}</span> <span class="muted">${esc(m.about || '')}</span></label>`
      ).join('')}</div>
    </section>
    ${mods
      .filter((m) => m.settings)
      .map(
        (m) => `<details class="card mod-settings" data-mod="${m.id}"${openSettings.has(m.id) ? ' open' : ''}>
          <summary><span aria-hidden="true">${m.emoji}</span> ${esc(m.label)} <small class="muted">${esc(m.settingsHint || '')}</small></summary>
          ${m.settings()}</details>`
      )
      .join('')}
    <section class="card">
      <h2>ข้อมูล</h2>
      <p class="hint">รอส่งขึ้นเซิร์ฟเวอร์: <b id="pending-count">${state.outbox.length}</b> รายการ · ไฟล์สำรองรวมทุกโมดูล และนำเข้าไฟล์สำรองจากแอปเดิม (health-tracker, bill-tracker, maintenance-tracker) ได้</p>
      <div class="row">
        <button type="button" class="btn" data-action="export-json">สำรองข้อมูลทั้งหมด (JSON)</button>
        <label class="btn">นำเข้าข้อมูลสำรอง<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      </div>
    </section>
    <section class="card">
      <h2>บัญชี</h2>
      <p class="hint">ออกจากระบบจะล้างข้อมูลที่เก็บไว้ในเครื่องนี้ด้วย</p>
      <button type="button" class="btn danger" data-action="logout">ออกจากระบบ</button>
    </section>
    <p class="foot muted">108 Tracker · <a href="https://github.com/monthop-gmail/108-tracker" target="_blank" rel="noopener">โค้ดเปิด</a></p>
    ${tabbar()}`;
  for (const m of mods) m.settingsAfter?.();
  updateSync();
  refreshPushUI();
  api('/api/settings')
    .then((r) => {
      const s = $('#digest-hour');
      if (s && !s.dataset.touched) s.value = String(r.digest_hour);
    })
    .catch(() => {});
}

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushUI() {
  const st = $('#push-status');
  if (!st || !pushSupported()) return;
  const show = (id, on) => {
    const el = $(id);
    if (el) el.hidden = !on;
  };
  try {
    const sub = await currentSub();
    if (Notification.permission === 'denied') {
      st.textContent = 'การแจ้งเตือนถูกปิดไว้ในการตั้งค่าของเบราว์เซอร์/เครื่อง — อนุญาตให้เว็บนี้แจ้งเตือนก่อน แล้วกลับมากดเปิดอีกครั้ง';
      show('#push-on', false);
    } else if (sub) {
      st.textContent = '✓ เครื่องนี้เปิดรับการแจ้งเตือนแล้ว';
      show('#push-on', false);
      show('#push-test', true);
      show('#push-digest', true);
      show('#push-off', true);
    } else {
      st.textContent = 'เครื่องนี้ยังไม่ได้เปิดรับการแจ้งเตือน';
      show('#push-on', true);
      show('#push-test', false);
      show('#push-digest', false);
      show('#push-off', false);
    }
  } catch {
    st.textContent = 'ตรวจสอบสถานะการแจ้งเตือนไม่ได้';
  }
}

async function pushOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('ยังไม่ได้รับอนุญาตให้แจ้งเตือน');
      return refreshPushUI();
    }
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), tz: localTz() } });
    toast('เปิดการแจ้งเตือนแล้ว — ลองกด "ส่งทดสอบ"');
  } catch (e) {
    if (!handleErr(e)) toast('เปิดการแจ้งเตือนไม่สำเร็จ');
  }
  refreshPushUI();
}

async function pushOff() {
  try {
    const sub = await currentSub();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    toast('ปิดการแจ้งเตือนบนเครื่องนี้แล้ว');
  } catch {
    toast('ไม่สำเร็จ');
  }
  refreshPushUI();
}

async function resyncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const sub = await currentSub();
    if (!sub) return;
    const { publicKey } = await api('/api/push/key');
    if (!sameKey(sub.options && sub.options.applicationServerKey, publicKey)) return;
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), tz: localTz() } });
  } catch {}
}

// ---------- สำรอง / นำเข้า ----------
const LEGACY = { 'daily-log': 'health', 'health-tracker': 'health', 'bill-tracker': 'bills', 'maintenance-tracker': 'maint' };

async function exportAll() {
  try {
    const modules = {};
    for (const m of ALL) if (m.exportData) modules[m.id] = await m.exportData();
    const data = { app: '108-tracker', version: 1, exported_at: new Date().toISOString(), modules };
    download(`108-tracker-backup_${today()}.json`, JSON.stringify(data, null, 1), 'application/json');
  } catch (e) {
    if (!handleErr(e)) toast('ส่งออกไม่สำเร็จ');
    else toast('ต้องต่ออินเทอร์เน็ตเพื่อส่งออก');
  }
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง');
  }
  // ไฟล์ของ 108-tracker มี modules แยกตามโมดูล / ไฟล์จากแอปเดิมเป็นข้อมูลของโมดูลเดียว
  let parts = [];
  if (data && data.modules && typeof data.modules === 'object') parts = Object.entries(data.modules).filter(([id]) => BY_ID.has(id));
  else if (data && LEGACY[data.app]) parts = [[LEGACY[data.app], data]];
  else if (data && Array.isArray(data.entries)) parts = [['health', data]];
  if (!parts.length) return toast('ไม่รู้จักรูปแบบไฟล์นี้');
  const done = [];
  try {
    for (const [id, d] of parts) {
      const m = BY_ID.get(id);
      if (!m.importData) continue;
      const msg = await m.importData(d);
      if (msg) done.push(`${m.label}: ${msg}`);
    }
    toast(done.length ? `นำเข้าแล้ว — ${done.join(' · ')}` : 'ไม่มีข้อมูลที่นำเข้า');
    await refreshAll();
  } catch (e) {
    if (!handleErr(e)) toast('นำเข้าไม่สำเร็จ');
  }
}

// ---------- ปุ่มของ core ----------
const actions = {
  'push-on': () => pushOn(),
  'push-off': () => pushOff(),
  'push-test': async (b) => {
    b.disabled = true;
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.sent ? `ส่งแล้ว ${r.sent} เครื่อง — ถ้าไม่เด้ง ลองเช็กการตั้งค่าการแจ้งเตือนของเครื่อง` : 'ส่งไม่สำเร็จ ลองปิดแล้วเปิดการแจ้งเตือนใหม่');
    } catch (e) {
      if (!handleErr(e)) toast('ส่งไม่สำเร็จ');
    }
    b.disabled = false;
  },
  'push-digest': async (b) => {
    b.disabled = true;
    try {
      const r = await api('/api/push/digest-now', { method: 'POST' });
      toast(r.items ? `ส่งสรุป ${r.items} เรื่องแล้ว` : 'ตอนนี้ไม่มีเรื่องที่ต้องเตือน');
    } catch (e) {
      if (!handleErr(e)) toast('ส่งไม่สำเร็จ');
    }
    b.disabled = false;
  },
  'export-json': () => exportAll(),
  logout: async () => {
    if (state.outbox.length && !confirm(`ยังมี ${state.outbox.length} รายการที่ยังไม่ได้ส่งขึ้นเซิร์ฟเวอร์ ออกจากระบบแล้วจะหายไป ยืนยัน?`)) return;
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {}
    for (const m of ALL) m.reset();
    state.outbox = [];
    persistOutbox();
    location.hash = '#/';
    showLogin();
  },
};

function dispatch(name, b, ev) {
  const i = name.indexOf(':');
  const fn = i > 0 ? BY_ID.get(name.slice(0, i))?.actions?.[name.slice(i + 1)] : actions[name];
  if (!fn) return false;
  ev.preventDefault();
  fn(b, ev);
  return true;
}

app.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-action]');
  if (!b || b.disabled) return;
  dispatch(b.dataset.action, b, ev);
});

/** โมดูลที่เป็นเจ้าของ element (ส่วนตั้งค่าของโมดูล หรือหน้าของโมดูล) */
const ownerOf = (el) => {
  const sec = el.closest('[data-mod]');
  if (sec && BY_ID.has(sec.dataset.mod)) return BY_ID.get(sec.dataset.mod);
  return BY_ID.get(state.route.mod);
};

app.addEventListener('input', (ev) => ownerOf(ev.target)?.onInput?.(ev));

app.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'import-file' && t.files && t.files[0]) {
    importFile(t.files[0]);
    t.value = '';
  } else if (t.id === 'digest-hour') {
    const hour = Number(t.value);
    t.dataset.touched = '1';
    api('/api/settings', { method: 'PUT', body: { digest_hour: hour, tz: localTz() } })
      .then(() => toast(`จะส่งสรุปทุกวันเวลา ${pad(hour)}:00`))
      .catch((e) => handleErr(e) || toast('บันทึกไม่สำเร็จ'));
  } else if (t.dataset && t.dataset.modToggle) {
    const ids = $$('[data-mod-toggle]')
      .filter((x) => x.checked)
      .map((x) => x.dataset.modToggle);
    if (!ids.length) {
      t.checked = true;
      return toast('ต้องเปิดไว้อย่างน้อย 1 โมดูล');
    }
    try {
      await api('/api/settings', { method: 'PUT', body: { modules: ids } });
      state.enabled = ids;
      store.set('t108_modules', ids);
      await Promise.allSettled(enabledMods().map((m) => m.refresh()));
      renderSettings();
    } catch (e) {
      t.checked = !t.checked;
      if (!handleErr(e)) toast('บันทึกไม่สำเร็จ');
    }
  } else if (t.dataset && t.dataset.f === 'hidden') {
    t.closest('.cat-edit')?.classList.toggle('is-hidden', t.checked);
  } else ownerOf(t)?.onChange?.(ev);
});

app.addEventListener('submit', (ev) => {
  if (ev.target.id === 'login-form') {
    ev.preventDefault();
    doLogin(ev.target);
  } else {
    const m = ownerOf(ev.target);
    if (m?.onSubmit) {
      ev.preventDefault();
      m.onSubmit(ev);
    }
  }
});

// ---------- router ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [mod, ...rest] = h.split('/');
  if (!mod) return { mod: null, path: '' };
  return { mod: decodeURIComponent(mod), path: rest.map(decodeURIComponent).join('/') };
}

function route() {
  if (state.authed === false) return renderLogin();
  const prev = `${state.route.mod}/${state.route.path}`;
  let r = parseHash();
  if (r.mod && !['settings', 'more'].includes(r.mod) && !(BY_ID.has(r.mod) && state.enabled.includes(r.mod))) r = { mod: null, path: '' };
  if (r.mod !== state.route.mod) BY_ID.get(state.route.mod)?.leave?.();
  state.route = r;
  if (sheetEl.open) closeSheet();
  render();
  if (prev !== `${r.mod}/${r.path}`) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function openDeepLink() {
  // ลิงก์ลัดจากไอคอนบนหน้าจอโฮม (?add=health:med) และปุ่มบนการแจ้งเตือน (?take=morning&date=...)
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return;
  history.replaceState(null, '', location.pathname + location.hash);
  for (const m of enabledMods()) if (m.deepLink?.(params)) return;
}

async function afterAuth() {
  route();
  await refreshAll();
  openDeepLink();
  flush();
  resyncPush();
}

// ---------- เริ่มต้น ----------
async function boot() {
  try {
    const me = await api('/api/me');
    state.authed = true;
    if (Array.isArray(me.modules) && me.modules.length) {
      state.enabled = me.modules;
      store.set('t108_modules', me.modules);
    }
  } catch (e) {
    if (e.status === 401) return showLogin();
    // ออฟไลน์: เปิดจากข้อมูลในเครื่อง
    state.authed = true;
    state.online = false;
  }
  if (state.online) await afterAuth();
  else {
    route();
    openDeepLink();
  }
}

window.addEventListener('online', () => {
  state.online = true;
  updateSync();
  flush();
  refreshAll();
});
window.addEventListener('offline', () => {
  state.online = false;
  updateSync();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state.authed !== true) return;
  flush();
  if (Date.now() - state.lastRefresh > 60000) refreshAll();
  else if (!sheetEl.open) rerender();
});
setInterval(() => {
  if (state.outbox.length && state.authed === true) flush();
}, 20000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();
