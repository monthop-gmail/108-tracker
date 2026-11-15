/**
 * 108 Tracker — บันทึกเรื่องร้อยแปดในชีวิตในแอปเดียว แยกเป็นโมดูล
 * Cloudflare Worker + D1
 *
 *   POST /api/login {password} · POST /api/logout · GET /api/me
 *   GET/PUT /api/settings          ค่าตั้งส่วนกลาง (เวลาสรุปประจำวัน, โมดูลที่เปิดใช้, โซนเวลา)
 *   POST /api/sync                 {ops:[{mod, table?, type:'put', item} | {mod, table?, type:'del', id, updated_at}]}
 *   /api/push/*                    การแจ้งเตือน → src/core/notify.ts
 *   /api/<โมดูล>/*                 → src/modules/<โมดูล>.ts
 */
import { Env, HttpError, json, readJson, getSetting, putSetting, validTz, getTz, localParts } from './core/util';
import { handleLogin, isAuthed, passwordReady, cookieHeader } from './core/auth';
import { handlePush, runDigest, runTick, cleanupReminders } from './core/notify';
import type { Module } from './core/module';
import { health } from './modules/health';
import { bills } from './modules/bills';
import { maint } from './modules/maint';
import { pantry } from './modules/pantry';

export type { Env };

/** ลำดับนี้คือลำดับในเมนูและในสรุปประจำวัน — เพิ่มโมดูลใหม่ที่นี่ */
export const MODULES: Module[] = [health, bills, maint, pantry];
const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

async function enabledModules(env: Env): Promise<Module[]> {
  const ids = await getSetting<string[] | null>(env, 'modules', null);
  if (!Array.isArray(ids)) return MODULES;
  return MODULES.filter((m) => ids.includes(m.id));
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // กัน CSRF: คำขอที่แก้ข้อมูลต้องมาจาก origin เดียวกัน
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return json({ error: 'bad_origin' }, 403);
  }

  if (path === '/api/login' && method === 'POST') return handleLogin(req, env, url);
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, '', 0) });

  if (!(await isAuthed(req, env))) {
    return json({ error: passwordReady(env) ? 'unauthorized' : 'password_not_configured' }, 401);
  }

  const now = Date.now();
  if (path === '/api/me' && method === 'GET') {
    return json({ ok: true, now, modules: (await enabledModules(env)).map((m) => m.id) });
  }

  if (path === '/api/settings' && method === 'GET') {
    return json({
      digest_hour: await getSetting<number>(env, 'digest_hour', 8),
      tz: await getTz(env),
      modules: (await enabledModules(env)).map((m) => m.id),
    });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const body = await readJson(req);
    if (body?.digest_hour !== undefined) {
      const hour = Number(body.digest_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return json({ error: 'bad_hour' }, 400);
      await putSetting(env, 'digest_hour', hour);
    }
    if (body?.modules !== undefined) {
      if (!Array.isArray(body.modules)) return json({ error: 'bad_modules' }, 400);
      const ids = MODULES.map((m) => m.id).filter((id) => body.modules.includes(id));
      if (!ids.length) return json({ error: 'need_one_module' }, 400);
      await putSetting(env, 'modules', ids);
    }
    if (validTz(body?.tz)) await putSetting(env, 'tz', body.tz);
    return json({ ok: true });
  }

  if (path === '/api/sync' && method === 'POST') {
    const body = await readJson(req);
    const ops = body?.ops;
    if (!Array.isArray(ops) || ops.length > 500) return json({ error: 'bad_ops' }, 400);
    const stmts: D1PreparedStatement[] = [];
    const rejected: { index: number; error: string }[] = [];
    ops.forEach((op: any, index: number) => {
      const mod = BY_ID.get(op?.mod);
      if (!mod?.syncOp) return void rejected.push({ index, error: 'bad_mod' });
      const r = mod.syncOp(env, op, now);
      if (typeof r === 'string') rejected.push({ index, error: r });
      else stmts.push(r);
    });
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, applied: stmts.length, rejected });
  }

  if (path.startsWith('/api/push/')) {
    const r = await handlePush(req, env, url, now, await enabledModules(env));
    if (r) return r;
  }

  const m = path.match(/^\/api\/([a-z]+)(\/.*)?$/);
  const mod = m && BY_ID.get(m[1]);
  if (mod) {
    const r = await mod.route(req, env, url, now, m[2] || '/');
    if (r) return r;
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status);
      console.error('api_error', err);
      return json({ error: 'server_error' }, 500);
    }
  },

  // Cron ทุกนาที: เตือนตามเวลา (ยา นัดหมอ) และต้นชั่วโมงส่งสรุปประจำวัน
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = controller.scheduledTime;
    ctx.waitUntil(
      (async () => {
        const mods = await enabledModules(env);
        const t = await runTick(env, mods, now);
        if (t.queued) console.log('tick', JSON.stringify(t));
        const { minutes } = localParts(now, await getTz(env));
        // สรุปประจำวันเช็กต้นชั่วโมง (หรือเมื่อถูกเรียกด้วย cron รายชั่วโมง เช่น ตอนทดสอบในเครื่อง)
        if (minutes % 60 === 0 || controller.cron !== '* * * * *') {
          const d = await runDigest(env, mods, now);
          if (d.items) console.log('digest', JSON.stringify(d));
        }
        if (minutes === 0) await cleanupReminders(env, now);
      })().catch((err) => console.error('scheduled_error', err))
    );
  },
} satisfies ExportedHandler<Env>;
