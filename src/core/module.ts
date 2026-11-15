/** สัญญาของโมดูล: ทุก tracker ประกาศสิ่งเดียวกัน แล้ว core จัดการ routing, sync, การเตือน และสรุปประจำวันให้ */
import { Env, json, readJson, clip, getSetting, putSetting, delSetting } from './util';

/** บรรทัดในสรุปประจำวัน */
export type DigestItem = { sort: number; overdue: boolean; line: string };
/** การแจ้งเตือนตามเวลา (key กันส่งซ้ำ) */
export type Note = { key: string; payload: Record<string, unknown> };

export interface Module {
  id: string;
  label: string;
  emoji: string;
  /** เส้นทาง /api/<id>/<sub> — คืน null ถ้าไม่ใช่ของโมดูลนี้ */
  route(req: Request, env: Env, url: URL, now: number, sub: string): Promise<Response | null>;
  /** ตรวจและแปลงคำสั่ง sync (ที่บันทึกจากเครื่องตอนออฟไลน์) เป็นคำสั่ง SQL — ผิดรูปแบบคืนข้อความ error */
  syncOp?(env: Env, op: any, now: number): D1PreparedStatement | string;
  /** รายการสำหรับสรุปประจำวัน */
  digest?(env: Env, today: string, now: number, tz: string): Promise<DigestItem[]>;
  /** การเตือนตามเวลา (cron ทุกนาที) */
  tick?(env: Env, now: number, tz: string): Promise<Note[]>;
}

// ---------- หมวด (ใช้ร่วมกันหลายโมดูล) ----------
export type Category = { key: string; label: string; emoji: string; hidden?: boolean; scale?: boolean; presets?: string[] };
const CAT_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
export const isCatKey = (v: unknown): v is string => typeof v === 'string' && CAT_KEY_RE.test(v);

export function validateCategories(input: any, withPresets = false): Category[] | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) return 'bad_categories';
  const seen = new Set<string>();
  const out: Category[] = [];
  for (const c of input) {
    if (!c || typeof c !== 'object') return 'bad_category';
    const key = String(c.key ?? '');
    if (!CAT_KEY_RE.test(key) || seen.has(key)) return 'bad_category_key';
    seen.add(key);
    const label = clip(c.label, 30);
    if (!label) return 'bad_category_label';
    const cat: Category = { key, label, emoji: clip(c.emoji, 16), hidden: !!c.hidden };
    if (withPresets) {
      cat.scale = !!c.scale;
      cat.presets = Array.isArray(c.presets)
        ? c.presets.map((p: unknown) => String(p).slice(0, 60)).filter((p: string) => p.trim()).slice(0, 20)
        : [];
    }
    out.push(cat);
  }
  return out;
}

export async function getCategories(env: Env, key: string, defaults: Category[], withPresets = false): Promise<Category[]> {
  const v = validateCategories(await getSetting<unknown>(env, key, null), withPresets);
  return typeof v === 'string' ? defaults : v;
}

/** GET/PUT <sub>/categories และ POST <sub>/categories/reset */
export async function categoryRoutes(
  req: Request,
  env: Env,
  sub: string,
  key: string,
  defaults: Category[],
  withPresets = false
): Promise<Response | null> {
  if (sub === '/categories' && req.method === 'GET') return json({ categories: await getCategories(env, key, defaults, withPresets) });
  if (sub === '/categories' && req.method === 'PUT') {
    const body = await readJson(req);
    const v = validateCategories(body?.categories, withPresets);
    if (typeof v === 'string') return json({ error: v }, 400);
    await putSetting(env, key, v);
    return json({ ok: true, categories: v });
  }
  if (sub === '/categories/reset' && req.method === 'POST') {
    await delSetting(env, key);
    return json({ ok: true, categories: defaults });
  }
  return null;
}

/** id ใน path เช่น /assets/<id> */
export const pathId = (sub: string, prefix: string): string | null => {
  const m = sub.match(new RegExp(`^/${prefix}/([A-Za-z0-9_-]{8,64})$`));
  return m ? m[1] : null;
};
