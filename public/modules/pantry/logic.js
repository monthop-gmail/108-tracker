/**
 * ตรรกะของในบ้าน — ใช้ร่วมกันทั้งหน้าเว็บและ Worker (สรุปประจำวัน)
 * วันที่เป็นสตริง 'YYYY-MM-DD' ตามเวลาท้องถิ่น
 */

const dayNum = (/** @type {string} */ s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / 86400000;

/** จำนวนวันจาก a ถึง b (b - a) */
export const diffDays = (/** @type {string} */ a, /** @type {string} */ b) => Math.round(dayNum(b) - dayNum(a));

export function addDays(/** @type {string} */ date, /** @type {number} */ n) {
  const d = new Date((dayNum(date) + n) * 86400000);
  return d.toISOString().slice(0, 10);
}

/** อีกกี่วันจะหมดอายุ (ติดลบ = หมดอายุแล้ว, null = ไม่ได้ใส่วันหมดอายุ) */
export const expiryLeft = (/** @type {any} */ item, /** @type {string} */ today) => (item.expires_on ? diffDays(today, item.expires_on) : null);

/** ต้องซื้อเพิ่มไหม (เหลือเท่ากับหรือน้อยกว่าจุดสั่งซื้อ) */
export const isLow = (/** @type {any} */ item) => item.min_qty != null && item.qty <= item.min_qty;

/** จำนวนที่ควรซื้อ: ตามที่ตั้งไว้ หรือเติมให้เกินจุดสั่งซื้อ */
export function buyAmount(/** @type {any} */ item) {
  if (item.buy_qty) return item.buy_qty;
  if (item.min_qty != null) return Math.max(1, Math.ceil(item.min_qty * 2 + 1 - item.qty));
  return 1;
}

/** สถานะสำหรับแสดงผล: expired / expiring / low / out / ok */
export function itemState(/** @type {any} */ item, /** @type {string} */ today) {
  const d = expiryLeft(item, today);
  if (d != null && item.qty > 0 && d < 0) return 'expired';
  if (d != null && item.qty > 0 && d <= item.remind_days) return 'expiring';
  if (item.qty <= 0) return 'out';
  if (isLow(item)) return 'low';
  return 'ok';
}
