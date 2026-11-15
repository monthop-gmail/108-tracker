/* ตัวแก้หมวด (ใช้ร่วมกันทุกโมดูล): ไอคอน ชื่อ ลำดับ ซ่อน — โมดูลสุขภาพมีคำที่ใช้บ่อยและระดับ 1–5 เพิ่ม */
import { $, $$, esc } from './util.js';

export class CatEditor {
  /**
   * @param {{mod: string, path: string, noun: string, rich?: boolean, newItem?: () => object}} opt
   */
  constructor(opt) {
    this.opt = opt;
    this.edit = null;
  }

  root() {
    return $(`[data-cat-editor="${this.opt.mod}"]`);
  }

  row(c, i) {
    const { mod, noun, rich } = this.opt;
    const n = this.edit.length;
    return `<div class="cat-edit${rich ? ' rich' : ''}${c.hidden ? ' is-hidden' : ''}" data-i="${i}">
      <input class="in emoji" data-f="emoji" value="${esc(c.emoji)}" maxlength="8" aria-label="ไอคอน">
      <input class="in label" data-f="label" value="${esc(c.label)}" maxlength="30" aria-label="ชื่อ${esc(noun)}">
      <div class="mini-actions">
        <button type="button" class="icon-btn sm" data-action="${mod}:cat-up" data-i="${i}" aria-label="เลื่อนขึ้น" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn sm" data-action="${mod}:cat-down" data-i="${i}" aria-label="เลื่อนลง" ${i === n - 1 ? 'disabled' : ''}>↓</button>
      </div>
      ${rich ? `<input class="in presets" data-f="presets" value="${esc((c.presets || []).join(', '))}" placeholder="คำที่ใช้บ่อย คั่นด้วย ,">` : ''}
      <div class="check">
        ${rich ? `<label><input type="checkbox" data-f="scale" ${c.scale ? 'checked' : ''}> มีระดับ 1–5</label>` : ''}
        <label><input type="checkbox" data-f="hidden" ${c.hidden ? 'checked' : ''}> ซ่อน</label>
      </div>
    </div>`;
  }

  /** HTML ของตัวแก้ (เรียกตอนวาดหน้าตั้งค่า) */
  html(current) {
    if (!this.edit) this.edit = JSON.parse(JSON.stringify(current));
    const { mod, noun } = this.opt;
    return `<div data-cat-editor="${mod}">${this.edit.map((c, i) => this.row(c, i)).join('')}</div>
      <div class="row"><button type="button" class="btn ghost" data-action="${mod}:cat-add">+ เพิ่ม${esc(noun)}</button></div>
      <div class="row end">
        <button type="button" class="btn ghost" data-action="${mod}:cat-reset">คืนค่าเริ่มต้น</button>
        <button type="button" class="btn primary" data-action="${mod}:cat-save">บันทึก</button>
      </div>`;
  }

  read() {
    const root = this.root();
    if (!root || !this.edit) return;
    for (const row of $$('.cat-edit', root)) {
      const c = this.edit[Number(row.dataset.i)];
      c.emoji = $('[data-f="emoji"]', row).value.trim();
      c.label = $('[data-f="label"]', row).value.trim();
      c.hidden = $('[data-f="hidden"]', row).checked;
      if (this.opt.rich) {
        c.presets = $('[data-f="presets"]', row)
          .value.split(',')
          .map((s) => s.replace(/^\s+/, ''))
          .filter((s) => s.trim());
        c.scale = $('[data-f="scale"]', row).checked;
      }
    }
  }

  redraw() {
    const root = this.root();
    if (root) root.innerHTML = this.edit.map((c, i) => this.row(c, i)).join('');
  }

  /**
   * จัดการปุ่มของตัวแก้ — คืน true ถ้าเป็นปุ่มของตัวแก้
   * @param {string} name @param {HTMLElement} b
   * @param {{api: Function, toast: Function, handleErr: Function, saved: (cats: any[]) => void}} h
   */
  async handle(name, b, h) {
    if (name === 'cat-add') {
      this.read();
      this.edit.push({ key: 'c' + Date.now().toString(36), label: `${this.opt.noun}ใหม่`, emoji: '⭐', hidden: false, ...(this.opt.rich ? { presets: [], scale: false } : {}) });
      this.redraw();
      const rows = $$('.cat-edit', this.root());
      $('[data-f="label"]', rows[rows.length - 1])?.select();
    } else if (name === 'cat-up' || name === 'cat-down') {
      this.read();
      const i = Number(b.dataset.i);
      const j = name === 'cat-up' ? i - 1 : i + 1;
      if (j >= 0 && j < this.edit.length) [this.edit[i], this.edit[j]] = [this.edit[j], this.edit[i]];
      this.redraw();
    } else if (name === 'cat-save') {
      this.read();
      if (this.edit.some((c) => !c.label)) return h.toast('กรุณาใส่ชื่อให้ครบ'), true;
      b.disabled = true;
      try {
        const r = await h.api(`/api/${this.opt.mod}${this.opt.path}`, { method: 'PUT', body: { categories: this.edit } });
        this.edit = null;
        h.saved(r.categories);
        h.toast('บันทึกแล้ว');
      } catch (e) {
        if (!h.handleErr(e)) h.toast('บันทึกไม่สำเร็จ');
        b.disabled = false;
      }
    } else if (name === 'cat-reset') {
      if (!confirm(`คืนค่า${this.opt.noun}เป็นค่าเริ่มต้น? (ข้อมูลเดิมไม่หาย)`)) return true;
      try {
        const r = await h.api(`/api/${this.opt.mod}${this.opt.path}/reset`, { method: 'POST' });
        this.edit = null;
        h.saved(r.categories);
      } catch (e) {
        if (!h.handleErr(e)) h.toast('ไม่สำเร็จ');
      }
    } else return false;
    return true;
  }
}
