/** การแจ้งเตือน (Web Push): สมัคร/ยกเลิก ส่งถึงทุกเครื่อง สรุปประจำวันรวมทุกโมดูล และการเตือนตามเวลา */
import { Env, json, readJson, getSetting, putSetting, clip, localParts, validTz, getTz, DAY } from './util';
import { generateVapidKeys, sendPush, VapidKeys, PushSub } from './push';
import type { Module, DigestItem } from './module';

async function getVapid(env: Env): Promise<VapidKeys> {
  const existing = await getSetting<VapidKeys | null>(env, 'vapid', null);
  if (existing?.publicKey && existing.privateJwk) return existing;
  const keys = await generateVapidKeys();
  await putSetting(env, 'vapid', keys);
  return keys;
}

function validEndpoint(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 1000) return false;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'); // ใช้ทดสอบ
  } catch {
    return false;
  }
}

const subCount = async (env: Env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>())?.n ?? 0;

export async function sendToAll(env: Env, payload: unknown): Promise<{ total: number; sent: number; failed: number }> {
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth, fails FROM push_subs').all<PushSub & { fails: number }>();
  if (!results.length) return { total: 0, sent: 0, failed: 0 };
  const keys = await getVapid(env);
  const subject = await getSetting<string>(env, 'app_origin', 'mailto:108-tracker@users.noreply.github.com');
  let sent = 0;
  let failed = 0;
  const now = Date.now();
  await Promise.all(
    results.map(async (s) => {
      const status = await sendPush(s, payload, keys, subject);
      if (status >= 200 && status < 300) {
        sent++;
        await env.DB.prepare('UPDATE push_subs SET last_ok = ?2, fails = 0 WHERE endpoint = ?1').bind(s.endpoint, now).run();
      } else {
        failed++;
        if (status === 404 || status === 410 || s.fails >= 20) {
          // เครื่องยกเลิกการแจ้งเตือนแล้ว
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
        } else {
          await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(s.endpoint).run();
        }
        console.warn('push_failed', status, new URL(s.endpoint).host);
      }
    })
  );
  return { total: results.length, sent, failed };
}

/** เส้นทาง /api/push/* */
export async function handlePush(req: Request, env: Env, url: URL, now: number, modules: Module[]): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/push/key' && method === 'GET') {
    const keys = await getVapid(env);
    const { results } = await env.DB.prepare('SELECT endpoint FROM push_subs').all<{ endpoint: string }>();
    return json({ publicKey: keys.publicKey, endpoints: results.map((r) => r.endpoint) });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson(req);
    const sub = body?.subscription;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (!validEndpoint(sub?.endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
      return json({ error: 'bad_subscription' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, ua, created_at, fails) VALUES (?1, ?2, ?3, ?4, ?5, 0)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fails = 0`
    )
      .bind(sub.endpoint, p256dh, auth, clip(req.headers.get('user-agent'), 200), now)
      .run();
    if (validTz(body?.tz)) await putSetting(env, 'tz', body.tz);
    if (url.protocol === 'https:') await putSetting(env, 'app_origin', url.origin);
    return json({ ok: true });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body?.endpoint === 'string') await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(body.endpoint).run();
    return json({ ok: true });
  }

  if (path === '/api/push/test' && method === 'POST') {
    const r = await sendToAll(env, {
      type: 'test',
      tag: 'test',
      title: 'ทดสอบการแจ้งเตือน',
      body: 'ถ้าเห็นข้อความนี้ แปลว่าการแจ้งเตือนของ 108 Tracker ใช้งานได้แล้ว',
      url: '/#/settings',
    });
    return json({ ok: true, ...r });
  }

  // ทดลองส่งสรุปประจำวันทันที (ใช้ตรวจสอบหลังตั้งค่า)
  if (path === '/api/push/digest-now' && method === 'POST') {
    return json({ ok: true, ...(await runDigest(env, modules, now, true)) });
  }

  return null;
}

// ---------- สรุปประจำวัน (รวมทุกโมดูลในการแจ้งเตือนเดียว) ----------

export async function runDigest(env: Env, modules: Module[], now = Date.now(), force = false): Promise<{ items: number; sent: number }> {
  if (!(await subCount(env))) return { items: 0, sent: 0 };
  const [tz, hour] = await Promise.all([getTz(env), getSetting<number>(env, 'digest_hour', 8)]);
  const { date, minutes } = localParts(now, tz);
  const h = Math.floor(minutes / 60);
  // ส่งตั้งแต่ชั่วโมงที่ตั้งไว้ (ถ้าส่งไม่สำเร็จจะลองใหม่อีก 2 ชั่วโมงถัดไป)
  if (!force && (h < hour || h > hour + 2)) return { items: 0, sent: 0 };

  const key = `digest:${date}`;
  if (!force) {
    const r = await env.DB.prepare('INSERT INTO reminders_sent (key, sent_at) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING').bind(key, now).run();
    if (!r.meta.changes) return { items: 0, sent: 0 };
  }

  const groups: { mod: Module; items: DigestItem[] }[] = [];
  for (const mod of modules) {
    if (!mod.digest) continue;
    try {
      const items = await mod.digest(env, date, now, tz);
      if (items.length) groups.push({ mod, items: items.sort((a, b) => a.sort - b.sort) });
    } catch (err) {
      console.error('digest_error', mod.id, err);
    }
  }
  const all = groups.flatMap((g) => g.items.map((i) => ({ ...i, line: `${g.mod.emoji} ${i.line}` })));
  if (!all.length) {
    // ไม่มีอะไรต้องเตือน — ปล่อยคีย์ไว้ เผื่อมีรายการเพิ่มระหว่างช่วงเวลาที่ส่ง
    if (!force) await env.DB.prepare('DELETE FROM reminders_sent WHERE key = ?').bind(key).run();
    return { items: 0, sent: 0 };
  }
  const overdue = all.filter((i) => i.overdue).length;
  const MAX = 14;
  const lines = all.slice(0, MAX).map((i) => i.line);
  if (all.length > MAX) lines.push(`และอีก ${all.length - MAX} รายการ`);
  const res = await sendToAll(env, {
    type: 'digest',
    tag: `digest-${date}`,
    title: overdue ? `มี ${overdue} เรื่องเลยกำหนด · รวม ${all.length} เรื่องวันนี้` : `วันนี้มี ${all.length} เรื่องต้องดูแล`,
    body: lines.join('\n'),
    url: '/',
  });
  if (!force && res.total > 0 && res.sent === 0) {
    await env.DB.prepare('DELETE FROM reminders_sent WHERE key = ?').bind(key).run(); // ลองใหม่ชั่วโมงถัดไป
  }
  return { items: all.length, sent: res.sent };
}

// ---------- การเตือนตามเวลา (cron ทุกนาที) ----------

export async function runTick(env: Env, modules: Module[], now = Date.now()): Promise<{ queued: number; sent: number }> {
  if (!(await subCount(env))) return { queued: 0, sent: 0 };
  const tz = await getTz(env);
  let queued = 0;
  let sent = 0;
  for (const mod of modules) {
    if (!mod.tick) continue;
    let notes;
    try {
      notes = await mod.tick(env, now, tz);
    } catch (err) {
      console.error('tick_error', mod.id, err);
      continue;
    }
    queued += notes.length;
    for (const n of notes) {
      // จองคีย์ก่อนส่ง กันส่งซ้ำแม้ cron ทับกัน
      const r = await env.DB.prepare('INSERT INTO reminders_sent (key, sent_at) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING')
        .bind(n.key, now)
        .run();
      if (!r.meta.changes) continue;
      const res = await sendToAll(env, n.payload);
      sent += res.sent;
      // ส่งไม่ถึงเครื่องไหนเลย (เช่น บริการ push ล่มชั่วคราว) → ปล่อยคีย์ให้ลองใหม่รอบถัดไป
      if (res.total > 0 && res.sent === 0) await env.DB.prepare('DELETE FROM reminders_sent WHERE key = ?').bind(n.key).run();
    }
  }
  return { queued, sent };
}

/** ล้างคีย์กันส่งซ้ำที่เก่าเกิน 60 วัน */
export const cleanupReminders = (env: Env, now: number) =>
  env.DB.prepare('DELETE FROM reminders_sent WHERE sent_at < ?').bind(now - 60 * DAY).run();
