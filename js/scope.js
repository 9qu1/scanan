// スコープ（かざすと頭の上の数字が見える演出）
// ・画面全体を覆う fixed レイヤー。円形マスクの内側だけ HUD が見える
// ・レティクル中心に一番近い .unit を「ロックオン」して onLock(pid) を返す
// ・reveal 用に自動でターゲットを舐める autoScan() を持つ
import { $, easeInOut, sleep, raf } from "./ui.js?v=86d3864";

export class Scope {
  constructor() {
    this.root = $("#scope");
    this.tag = $("#scopeTag");
    this.btn = $("#scopeToggle");
    this.active = false;
    this.auto = false;
    this.lockPid = null;
    this.onLock = null;
    this.units = [];
    this.x = window.innerWidth / 2;
    this.y = window.innerHeight * 0.38;
    this.r = this.radius();

    const onPointer = (e) => {
      if (!this.active || this.auto) return;
      if (e.pointerType === "touch" && e.type === "pointermove" && e.buttons === 0 && !this._touching) return;
      this.move(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", (e) => { this._touching = true; onPointer(e); }, { passive: true });
    window.addEventListener("pointerup", () => (this._touching = false), { passive: true });
    window.addEventListener("resize", () => { if (this.active) { this.r = this.radius(); this.apply(); this.refresh(); } });
  }

  radius() { return Math.max(84, Math.min(window.innerWidth, window.innerHeight) * 0.17); }

  /** ラインナップの座標を測り直す（カード再描画・スクロール後に呼ぶ） */
  refresh() {
    this.units = [...document.querySelectorAll("#lineup .unit")].map((n) => {
      const b = n.getBoundingClientRect();
      return { node: n, pid: n.dataset.pid, cx: b.left + b.width / 2, cy: b.top + b.height * 0.34 };
    });
  }

  enable({ onLock = null, tag = "SCANNING…" } = {}) {
    this.active = true;
    this.onLock = onLock;
    this.root.hidden = false;
    this.btn.classList.add("on");
    document.body.classList.add("scoping");
    this.r = this.radius();
    this.tag.textContent = tag;
    this.refresh();
    this.apply();
    this.lockPid = null;             // ★呼び直したときも、照準の下のカードで onLock が呼ばれるように
    this.detect();
  }

  disable() {
    this.active = false;
    this.auto = false;
    this.root.hidden = true;
    this.btn.classList.remove("on");
    this.root.classList.remove("lock");
    document.body.classList.remove("scoping");
    this.units.forEach((u) => u.node.classList.remove("lock"));
    this.lockPid = null;
  }

  toggle(opts) { this.active ? this.disable() : this.enable(opts); }

  apply() {
    const s = this.root.style;
    s.setProperty("--sx", `${this.x}px`);
    s.setProperty("--sy", `${this.y}px`);
    s.setProperty("--sr", `${this.r}px`);
  }

  move(x, y) {
    this.x = Math.max(20, Math.min(window.innerWidth - 20, x));
    this.y = Math.max(20, Math.min(window.innerHeight - 20, y));
    this.apply();
    this.detect();
  }

  detect() {
    if (!this.units.length) this.refresh();
    let best = null, bestD = Infinity;
    for (const u of this.units) {
      const d = Math.hypot(u.cx - this.x, u.cy - this.y);
      if (d < bestD) { bestD = d; best = u; }
    }
    const hit = best && bestD < this.r * 0.9 ? best : null;
    const pid = hit ? hit.pid : null;
    if (pid === this.lockPid) return;
    this.units.forEach((u) => u.node.classList.toggle("lock", u === hit));
    this.root.classList.toggle("lock", !!hit);
    this.lockPid = pid;
    if (hit) {
      const nm = hit.node.dataset.name || "";
      this.tag.textContent = `LOCK ${nm}`.trim();
    } else {
      this.tag.textContent = "SCANNING…";
    }
    this.onLock?.(pid);
  }

  /** (x,y) までレティクルをなめらかに動かす */
  glide(x, y, ms = 520) {
    if (document.visibilityState !== "visible") {   // 裏タブでは瞬間移動（演出を待たせない）
      this.x = x; this.y = y; this.apply(); this.detect();
      return Promise.resolve();
    }
    return new Promise((done) => {
      const x0 = this.x, y0 = this.y, t0 = performance.now();
      let finished = false;
      const finish = () => { if (finished) return; finished = true; this.x = x; this.y = y; this.apply(); this.detect(); done(); };
      const step = (now) => {
        if (finished) return;
        const p = Math.min(1, (now - t0) / ms);
        const e = easeInOut(p);
        this.x = x0 + (x - x0) * e;
        this.y = y0 + (y - y0) * e;
        this.apply();
        if (p < 1) raf(step);
        else finish();
      };
      raf(step);
      setTimeout(finish, ms + 400);     // ★保険: rAFが動かない環境でも必ず先へ進む
    });
  }

  /** 一人ずつ自動でスキャンしていく（結果発表用） */
  async autoScan(pids, { dwell = 950, travel = 520, onArrive = null } = {}) {
    this.auto = true;
    if (!this.active) this.enable({ tag: "AUTO SCAN" });
    this.refresh();
    for (const pid of pids) {
      const u = this.units.find((x) => x.pid === pid);
      if (!u) continue;
      await this.glide(u.cx, u.cy, travel);
      await onArrive?.(pid);
      await sleep(dwell);
      if (!this.active) break;          // 途中で画面が変わったら中断
    }
    this.auto = false;
  }
}
