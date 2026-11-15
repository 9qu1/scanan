// 小さな UI ユーティリティ
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

export const avUrl = (id, thumb = false) => `img/av/${id || "a01"}${thumb ? "-t" : ""}.webp`;
export const fmt = (v) => Number(v).toLocaleString("ja-JP");

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/** 画面が裏に回っていると requestAnimationFrame が止まるので、そのときはタイマーで進める。
 *  （これがないと結果発表の途中でスマホをロックされたまま「解析中…」で固まる） */
export const raf = (cb) => (document.visibilityState === "visible" ? requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16));

/** 数字をガチャガチャ回してから確定させる（スコープの「解析」感） */
export function rollNumber(node, to, { dur = 700, max = null } = {}) {
  const target = Number(to) || 0;
  // ★まず確定値を書いてから演出をかぶせる。
  //   演出（rAF）が動かない環境でも「数字が出ない」ことだけは起きないようにするため。
  node.textContent = fmt(target);
  // 画面が裏なら演出そのものを省く（裏タブはタイマーが1秒間隔に絞られるので、回すと何十秒もかかる）
  if (document.visibilityState !== "visible") return Promise.resolve();
  const start = performance.now();
  const cap = max ?? Math.max(10, to * 2 || 99);
  return new Promise((done) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      if (p < 1) {
        // 終盤ほど正解に寄せる
        const noise = (1 - p) ** 2;
        const v = Math.round(target + (Math.random() * 2 - 1) * cap * noise);
        node.textContent = fmt(Math.max(0, v));
        raf(tick);
      } else {
        node.textContent = fmt(target);
        done();
      }
    };
    raf(tick);
    setTimeout(() => { node.textContent = fmt(target); done(); }, dur + 400);   // 保険
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
