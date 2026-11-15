export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  API_TOKEN?: string;
}

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const DATE_RE = /^(19\d\d|20\d\d|21\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MIN_TS = Date.UTC(2000, 0, 1);
export const DAY = 86400000;
export const enc = new TextEncoder();

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function putSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export const delSetting = (env: Env, key: string) => env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

/** ตัดข้อความให้ไม่เกินความยาว (นับเป็นตัวอักษร) */
export const clip = (v: unknown, max: number): string => (v == null ? '' : String(v)).trim().slice(0, max);

export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);
export const optDate = (v: unknown): string | null | 'bad' => (v == null || v === '' ? null : isDate(v) ? v : 'bad');
/** ตัวเลขไม่ติดลบ (ปัด 2 ตำแหน่ง) — ว่าง = null, ผิดรูปแบบ = 'bad' */
export const num = (v: unknown, max = 1e10): number | null | 'bad' => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : 'bad';
};
/** updated_at ที่ส่งมาจากเครื่อง (ใช้ตัดสิน last-write-wins) — ถ้าผิดปกติใช้เวลาปัจจุบัน */
export const clientTs = (v: unknown, now: number): number => {
  const u = Number(v);
  return Number.isFinite(u) && u >= MIN_TS && u <= now + 60000 ? Math.round(u) : now;
};

// ---------- โซนเวลา ----------
export const DEFAULT_TZ = 'Asia/Bangkok';

const dtfCache = new Map<string, Intl.DateTimeFormat>();
/** วันที่ (YYYY-MM-DD) และนาทีของวัน ตามโซนเวลา */
export function localParts(ts: number, tz: string): { date: string; minutes: number } {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    dtfCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ts)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const getTz = async (env: Env) => {
  const tz = await getSetting<string>(env, 'tz', DEFAULT_TZ);
  return validTz(tz) ? tz : DEFAULT_TZ;
};
