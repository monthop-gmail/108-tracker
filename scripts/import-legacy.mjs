#!/usr/bin/env node
// ย้ายข้อมูลจากแอปเดิม 3 ตัว (ฐานข้อมูล D1 แยกกัน) เข้าฐานข้อมูลของ 108-tracker
//
//   node scripts/import-legacy.mjs            ย้าย/ซิงก์ข้อมูล (รันซ้ำได้ — แถวที่ใหม่กว่าในฐานใหม่จะไม่ถูกทับ)
//   node scripts/import-legacy.mjs --once     ทำเฉพาะครั้งแรก (ถ้าเคยย้ายแล้วจะข้าม) — ใช้ใน CI ตอน deploy
//   node scripts/import-legacy.mjs --local    ใช้ฐานข้อมูลในเครื่อง (ทดสอบ) ร่วมกับ LEGACY_CONFIG=<wrangler config ของฐานเดิม>
//
// ชื่อฐานข้อมูลเดิมเปลี่ยนได้ด้วย env: LEGACY_HEALTH_DB, LEGACY_BILLS_DB, LEGACY_MAINT_DB
// ถ้าไม่พบฐานข้อมูลเดิมเลย (เช่น fork ไปใช้ใหม่) จะจบโดยไม่ทำอะไร
//
// หมายเหตุ: การเตือน (push) ต้องเปิดใหม่ในแอปใหม่ เพราะเป็นคนละเว็บ — สคริปต์นี้ไม่ย้าย push_subs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const LOCAL = args.has('--local');
const ONCE = args.has('--once');
const WHERE = LOCAL ? '--local' : '--remote';
const NEW_DB = (readFileSync('wrangler.jsonc', 'utf8').match(/"database_name"\s*:\s*"([^"]+)"/) || [])[1] || '108-tracker';

const SOURCES = [
  {
    mod: 'health',
    names: [process.env.LEGACY_HEALTH_DB || 'daily-health-log', 'health-tracker'],
    tables: { entries: 'health_entries', meds: 'health_meds', appointments: 'health_appts' },
    settings: { categories: 'health.categories', med_slots: 'health.med_slots', tz: 'tz' },
  },
  {
    mod: 'bills',
    names: [process.env.LEGACY_BILLS_DB || 'bill-tracker'],
    tables: { bills: 'bills_items', payments: 'bills_payments' },
    settings: { categories: 'bills.categories', remind_hour: 'digest_hour', tz: 'tz' },
  },
  {
    mod: 'maint',
    names: [process.env.LEGACY_MAINT_DB || 'maintenance-tracker'],
    tables: { assets: 'maint_assets', tasks: 'maint_tasks', logs: 'maint_logs' },
    settings: { categories: 'maint.categories', remind_hour: 'digest_hour', tz: 'tz' },
  },
];

// คอลัมน์ของตารางใหม่ (เหมือนตารางเดิมทุกคอลัมน์)
const COLUMNS = {
  health_entries: ['id', 'ts', 'category', 'text', 'level', 'meta', 'deleted', 'created_at', 'updated_at'],
  health_meds: ['id', 'name', 'dose', 'method', 'instructions', 'purpose', 'notes', 'slots', 'start_date', 'end_date', 'active', 'sort', 'created_at', 'updated_at'],
  health_appts: ['id', 'ts', 'title', 'place', 'doctor', 'details', 'remind', 'status', 'result', 'created_at', 'updated_at'],
  bills_items: ['id', 'name', 'category', 'amount', 'unit', 'every', 'start_due', 'end_date', 'count', 'remind_days', 'autopay', 'method', 'details', 'active', 'created_at', 'updated_at'],
  bills_payments: ['id', 'bill_id', 'period', 'paid_date', 'name', 'category', 'amount', 'method', 'note', 'status', 'deleted', 'created_at', 'updated_at'],
  maint_assets: ['id', 'name', 'category', 'location', 'brand', 'model', 'serial', 'purchase_date', 'price', 'warranty_until', 'warranty_remind_days', 'contact', 'notes', 'meter_unit', 'meter_start', 'meter_start_date', 'active', 'created_at', 'updated_at'],
  maint_tasks: ['id', 'asset_id', 'name', 'unit', 'every', 'every_meter', 'first_due', 'first_due_meter', 'remind_days', 'remind_meter', 'est_cost', 'notes', 'active', 'created_at', 'updated_at'],
  maint_logs: ['id', 'asset_id', 'task_id', 'kind', 'done_date', 'title', 'meter', 'cost', 'provider', 'note', 'deleted', 'created_at', 'updated_at'],
};

const wrangler = (a) => execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });

/** ดึง array JSON ออกจากผลลัพธ์ของ wrangler (เผื่อมีข้อความอื่นปนมา) */
function parseJsonArray(out) {
  const end = out.lastIndexOf(']');
  for (let i = out.indexOf('['); i >= 0 && i < end; i = out.indexOf('[', i + 1)) {
    try {
      const v = JSON.parse(out.slice(i, end + 1));
      if (Array.isArray(v)) return v;
    } catch {}
  }
  return [];
}

function query(db, sql, config) {
  const out = wrangler(['d1', 'execute', db, WHERE, '--json', '--command', sql, ...(config ? ['--config', config] : [])]);
  const res = parseJsonArray(out);
  return (res[0] && res[0].results) || [];
}

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
};

function upsert(table, row) {
  const cols = COLUMNS[table];
  const vals = cols.map((c) => {
    if (row[c] !== undefined) return lit(row[c]);
    if (c === 'deleted') return '0';
    if (c === 'created_at') return lit(row.updated_at ?? Date.now());
    return 'NULL';
  });
  const set = cols.filter((c) => c !== 'id' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ');
  // แถวที่ถูกแก้ในแอปใหม่ภายหลัง (updated_at ใหม่กว่า) จะไม่ถูกทับ
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT(id) DO UPDATE SET ${set} WHERE excluded.updated_at > ${table}.updated_at;`;
}

// ---------- หาฐานข้อมูลเดิม ----------
let legacyConfig = process.env.LEGACY_CONFIG || null;
const found = [];
if (LOCAL) {
  if (!legacyConfig) throw new Error('--local ต้องระบุ LEGACY_CONFIG');
  const cfg = readFileSync(legacyConfig, 'utf8');
  for (const s of SOURCES) {
    const name = s.names.find((n) => cfg.includes(`"${n}"`));
    if (name) found.push({ ...s, db: name });
  }
} else {
  const list = parseJsonArray(wrangler(['d1', 'list', '--json']));
  const binds = [];
  for (const s of SOURCES) {
    const db = list.find((d) => s.names.includes(d.name));
    if (!db) continue;
    found.push({ ...s, db: db.name });
    binds.push({ binding: `LEGACY_${s.mod.toUpperCase()}`, database_name: db.name, database_id: db.uuid || db.id || db.database_id });
  }
  if (binds.length) {
    // config ชั่วคราวที่รู้จักฐานข้อมูลเดิม (ไม่แตะ wrangler.jsonc ของแอป)
    const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
    legacyConfig = join(dir, 'wrangler.json');
    writeFileSync(legacyConfig, JSON.stringify({ name: 'legacy-import', compatibility_date: '2026-10-01', d1_databases: binds }, null, 2));
  }
}

if (!found.length) {
  console.log('ไม่พบฐานข้อมูลของแอปเดิม — ไม่มีอะไรต้องย้าย');
  process.exit(0);
}

if (ONCE) {
  const done = query(NEW_DB, "SELECT value FROM settings WHERE key = 'legacy_import'");
  if (done.length) {
    console.log(`เคยย้ายข้อมูลแล้ว (${done[0].value}) — ข้าม (รันโดยไม่ใส่ --once เพื่อซิงก์อีกครั้ง)`);
    process.exit(0);
  }
}

// ---------- อ่านข้อมูลเดิม ----------
const sql = [];
const counts = {};
for (const s of found) {
  console.log(`อ่าน ${s.db} (${s.mod})…`);
  for (const [oldTable, newTable] of Object.entries(s.tables)) {
    let rows = [];
    try {
      rows = query(s.db, `SELECT * FROM ${oldTable}`, legacyConfig);
    } catch (e) {
      console.warn(`  ข้าม ${oldTable}: ${String(e.stderr || e.message).split('\n').find((l) => l.trim()) || e.message}`);
      continue;
    }
    for (const r of rows) sql.push(upsert(newTable, r));
    counts[newTable] = rows.length;
    console.log(`  ${oldTable} → ${newTable}: ${rows.length} แถว`);
  }
  // ค่าตั้ง: ใช้ของเดิมเฉพาะที่แอปใหม่ยังไม่ได้ตั้ง
  let settings = [];
  try {
    settings = query(s.db, 'SELECT key, value, updated_at FROM settings', legacyConfig);
  } catch {}
  for (const row of settings) {
    const key = s.settings[row.key];
    if (!key) continue;
    sql.push(`INSERT INTO settings (key, value, updated_at) VALUES (${lit(key)}, ${lit(row.value)}, ${lit(row.updated_at)}) ON CONFLICT(key) DO NOTHING;`);
  }
}

const marker = JSON.stringify({ at: new Date().toISOString(), from: found.map((s) => s.db), counts });
sql.push(`INSERT INTO settings (key, value, updated_at) VALUES ('legacy_import', ${lit(marker)}, ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`);

const dir = mkdtempSync(join(tmpdir(), 'legacy-sql-'));
const file = join(dir, 'import.sql');
writeFileSync(file, sql.join('\n') + '\n');
console.log(`เขียนข้อมูลเข้า ${NEW_DB} (${sql.length} คำสั่ง)…`);
const out = wrangler(['d1', 'execute', NEW_DB, WHERE, '--file', file, '--yes']);
if (/error/i.test(out) && !/"success":\s*true/.test(out)) console.log(out);
console.log('ย้ายข้อมูลเสร็จแล้ว:', marker);
