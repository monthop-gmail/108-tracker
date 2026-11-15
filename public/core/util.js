/* เครื่องมือที่ทุกโมดูลใช้ร่วมกัน (หน้าเว็บ) */

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const pad = (n) => String(n).padStart(2, '0');

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

// ---------- วันที่ / ตัวเลข ----------
export const localDate = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const today = () => localDate();
export const dateObj = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const F_FULL = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
export const F_DM = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });
export const F_WD = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
export const F_MON = new Intl.DateTimeFormat('th-TH', { month: 'short' });
export const F_MONTH = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' });
export const F_LONG = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtFull = (s) => F_FULL.format(dateObj(s));
export const fmtDM = (s) => F_DM.format(dateObj(s));
export const NUM = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
export const NUM2 = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
export const MONEY = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const MONEY2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ฿1,234 หรือ ฿1,234.50 (ถ้ามีเศษสตางค์) */
export const baht = (n, empty = '') => (n == null ? empty : `฿${(Math.round(n * 100) % 100 ? MONEY2 : MONEY).format(n)}`);
export const fmtN = (n) => NUM.format(n);
export const monthOf = (s) => s.slice(0, 7);
export const monthLabel = (ym) => F_MONTH.format(dateObj(`${ym}-01`));

export const uuid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** แปลงข้อความเป็นตัวเลข (ตัด , ช่องว่าง ฿) — ว่าง = null, ผิด = NaN */
export function parseNum(v) {
  const s = String(v ?? '').replace(/[,\s฿]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

export const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const ICON = {
  home: svg('<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>'),
  heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M8 12h2l1-2 2 4 1-2h2"/>'),
  receipt: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  wrench: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  basket: svg('<path d="M4 10h16l-1.5 9a1 1 0 0 1-1 .9H6.5a1 1 0 0 1-1-.9z"/><path d="M8 10l3-6M16 10l-3-6M9 14v3M12 14v3M15 14v3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  check: svg('<path d="M5 12l5 5 9-10"/>'),
  share: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>'),
};

export function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/** แปลงตารางเป็น CSV (มี BOM ให้ Excel อ่านภาษาไทยได้) */
export function csv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** หัวแผ่น (bottom sheet) */
export const sheetHead = (title) => `<div class="grip" aria-hidden="true"></div>
  <div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn plain" data-x="close" aria-label="ปิด">${ICON.close}</button></div>`;
