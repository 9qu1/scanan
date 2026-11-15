// スキャナン クライアント
import { $, $$, el, avUrl, fmt, toast, rollNumber, sleep } from "./ui.js?v=86d3864";
import { Scope } from "./scope.js?v=86d3864";

// ★版番号（サーバーが index.html に差し込む）。接続時に名乗り、サーバーの版と違えば読み込み直す
const MY_BUILD = document.querySelector('meta[name="build"]')?.content || "";
const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 2000,   // 再接続の待ちを短く
  auth: { build: MY_BUILD && MY_BUILD !== "__BUILD__" ? MY_BUILD : "dev" } });
const scope = new Scope();
// このページの住所（本番の 9qu1.com/scanan/ の下でも、手元の / でも）。招待リンク・シェアに使う
const pageUrl = () => location.origin + location.pathname.replace(/[^/]*$/, "");

// best = いちばん面白く遊べる人数。3〜12人ならどのモードでも遊べる（あくまで目安）
const MODES = {
  match: { name: "ダレノスウジ", sub: "この数字、誰のだ？", best: [4, 8], note: "3人だと選択肢が少なく、多すぎると割り当てが大変",
    desc: "全員がお題の数字を秘密で入力。数字だけがバラバラに浮かび上がるので、どの数字が誰のものかを当てる。" },
  gap: { name: "ギャップスキャン", sub: "自己申告 vs みんなの採点", best: [4, 12], note: "採点する人が多いほど平均が面白くなる",
    desc: "ターゲットの自己申告と、みんながその人に付けた採点の平均。ズレが大きいほど盛り上がる。" },
  pita: { name: "ピタリスキャン", sub: "近ければ近いほど高得点", best: [3, 12], note: "人数を選ばない。少人数でも成立する",
    desc: "ターゲットの数字を全員で予想。ピタリ賞は特大ボーナス。誰にも読まれなかったターゲットにも得点。" },
  oya: { name: "オヤメガネ", sub: "数字だけでお題を当てろ", best: [4, 10], note: "数字が2つだけだと推理が運任せになりがち",
    desc: "親だけがお題を知らない。スコープで全員の数字を覗いてお題を推理し、自分の言葉で答える（2回まで）。当たりかどうかはお題を知っているみんなが判定。" },
  mix: { name: "ぜんぶミックス", sub: "4モードを順ぐりに", best: [4, 8], note: "4モード全部が気持ちよく回る人数",
    desc: "ラウンドごとに4つのモードを順番に。いちばん盛り上がるのはこれ。" },
};
const bestLabel = (k) => { const b = MODES[k].best; return `${b[0]}〜${b[1]}人`; };
const AVATARS = Array.from({ length: 16 }, (_, i) => "a" + String(i + 1).padStart(2, "0"));

// ── ローカル保存 ──────────────────────────────────────────
const KEY = "scanan.v1";
const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } },
  set(o) { try { localStorage.setItem(KEY, JSON.stringify({ ...store.get(), ...o })); } catch {} },
};

let V = null;                       // 最新の view
let clockOffset = 0;                // 端末とサーバーの時計ずれ
let me = { code: null, token: null, id: null };
let draft = { mode: "create", name: "", avatar: AVATARS[Math.floor(Math.random() * 16)] };
const ui = { panelKey: "", phaseKey: "", lineKey: "", value: null, sent: false, sentAt: 0, assign: {}, selSlot: null, pick: null, revealKey: "", shown: new Set(), hintPick: false };
let leftCode = null;   // 自分で出た部屋。出る前に配られて遅れて届く state を捨てる（ゲーム画面に引き戻されて固まっていた）
/** 部屋ごと・ゲームごとの画面の状態を全部戻す。部屋を出る・消える・「もう一回」のとき
 *  （ラウンド番号だけの鍵が残ると、次の部屋の R1 で結果が出ない・前の割り当てが残る） */
function resetRoomUi() {
  clearTimeout(ui.autoTimer);
  revealGen++;                                       // 走っている結果の演出も止める
  Object.assign(ui, { panelKey: "", phaseKey: "", lineKey: "", revealKey: "", assignKey: "", assign: {}, selSlot: null, locked: false,
    sent: false, sentAt: 0, hintPick: false, draft: null, hintDraft: null, oyaDraft: null, pendingVote: null, hintToastFor: null });
  ui.shown.clear();
}

// ── 画面切り替え ──────────────────────────────────────────
const BG = { home: "", setup: "img/bg-title.webp", lobby: "img/bg-title.webp", game: "img/bg-lineup.webp", end: "img/bg-title.webp" };
function show(name) {
  $$(".screen").forEach((s) => s.classList.toggle("is-active", s.id === "screen-" + name));
  $("#bgImg").style.backgroundImage = BG[name] ? `url(${BG[name]})` : "none";
  if (name !== "game") { scope.disable(); $("#scopeToggle").hidden = true; }
}

// ══════════ ホーム / セットアップ ══════════
$$("[data-go]").forEach((b) => b.addEventListener("click", () => {
  const go = b.dataset.go;
  if (go === "home") return show("home");
  draft.mode = go;
  $("#setupTitle").textContent = go === "create" ? "部屋をつくる" : "合言葉で参加";
  $("#codeField").hidden = go !== "join";
  $("#setupErr").hidden = true;
  show("setup");
  setTimeout(() => (go === "join" ? $("#inCode") : $("#inName")).focus(), 120);
}));

function buildAvatars() {
  const g = $("#avatarGrid");
  g.replaceChildren(...AVATARS.map((id) =>
    el("button", { class: "av-btn" + (id === draft.avatar ? " on" : ""), dataset: { id }, type: "button", onclick: () => {
      draft.avatar = id;
      $$(".av-btn", g).forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    } }, [el("img", { src: avUrl(id, true), alt: "", loading: "lazy" })])
  ));
}

$("#setupGo").addEventListener("click", () => {
  const name = $("#inName").value.trim();
  const code = $("#inCode").value.trim().toUpperCase();
  const err = $("#setupErr");
  if (!name) { err.textContent = "なまえを入れてください"; err.hidden = false; return; }
  if (draft.mode === "join" && code.length !== 4) { err.textContent = "合言葉は4文字です"; err.hidden = false; return; }
  err.hidden = true;
  draft.name = name;
  store.set({ name, avatar: draft.avatar });
  if (!socket.connected) { err.textContent = "つながっていません。少し待ってからもう一度押してください"; err.hidden = false; socket.connect(); return; }
  const ev = draft.mode === "create" ? "room:create" : "room:join";
  $("#setupGo").disabled = true;
  socket.timeout(6000).emit(ev, { name, avatar: draft.avatar, code }, (e, res) => {
    $("#setupGo").disabled = false;
    if (e) { err.textContent = "返事が届きませんでした。もう一度押してください"; err.hidden = false; return; }
    if (!res?.ok) { err.textContent = res?.error || "うまくいきませんでした"; err.hidden = false; return; }
    me = { code: res.code, token: res.token, id: res.id };
    leftCode = null;
    resetRoomUi();
    store.set({ code: res.code, token: res.token, avatar: res.avatar || draft.avatar });
    history.replaceState(null, "", `?r=${res.code}`);
    if (res.avatar && res.avatar !== draft.avatar) {         // 先客とかぶったので自動で振り直された
      draft.avatar = res.avatar;
      buildAvatars();
      toast("えらんだアバターが先客とかぶったので、別のに変えました", 3200);
    }
  });
});
$("#inCode").addEventListener("input", (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")));

const MODE_KEYS = ["match", "gap", "pita", "oya"];
/** モードアイコン（mix は4つを2x2で見せる） */
function modeIcon(key, cls = "") {
  if (key === "mix") return el("div", { class: cls }, MODE_KEYS.map((k) => el("img", { src: `img/ic-${k}.webp`, alt: "", loading: "lazy" })));
  return el("img", { class: cls + " single", src: `img/ic-${key}.webp`, alt: "", loading: "lazy" });
}

// ══════════ ロビー ══════════
function renderLobby() {
  $("#lobbyCode").textContent = V.code;
  const conn = V.players.filter((p) => p.connected).length;
  const off = V.players.length - conn;
  $("#lobbyCount").textContent = off ? `${conn}（離席 ${off}）` : String(conn);
  $("#lobbyPlayers").replaceChildren(...V.players.map((p) =>
    el("div", { class: "lp" + (p.connected ? "" : " off") }, [
      el("img", { src: avUrl(p.avatar), alt: "" }),
      p.id === V.hostId ? el("span", { class: "lp-host", text: "HOST" }) : null,
      p.connected ? null : el("span", { class: "lp-off", text: "離席中" }),
      V.you?.isHost && p.id !== V.you.id ? el("button", { class: "lp-kick", text: "×", title: "退出させる", onclick: () => emit("room:kick", { id: p.id }) }) : null,
      el("span", { class: "lp-name", text: p.name }),
    ])
  ));

  const host = !!V.you?.isHost;
  $("#hostBox").hidden = !host;
  $("#guestNote").hidden = host;
  if (!host) return;

  const modeRow = $("#optMode");
  if (!modeRow.children.length) {
    modeRow.replaceChildren(...["mix", "match", "gap", "pita", "oya"].map((k) =>
      el("button", { class: "mode-card" + (k === "mix" ? " wide" : ""), dataset: { v: k }, type: "button", onclick: () => emit("room:settings", { mode: k }) }, [
        modeIcon(k, "mc-ic"),
        el("div", { class: "mc-body" }, [el("b", { text: MODES[k].name }), el("span", { text: MODES[k].sub })]),
        el("span", { class: "mc-num", text: bestLabel(k) }),
      ])
    ));
  }
  $$(".mode-card", modeRow).forEach((c) => c.classList.toggle("on", c.dataset.v === V.settings.mode));
  const m = MODES[V.settings.mode] || MODES.mix;
  const n = V.players.filter((p) => p.connected).length;
  const fit = n >= m.best[0] && n <= m.best[1];
  $("#modeDesc").textContent = m.desc;
  const judge = $("#modeFit");
  judge.className = "mode-fit " + (n < 3 ? "warn" : fit ? "good" : "soso");
  judge.textContent = n < 3 ? `いま${n}人。3人から遊べます`
    : fit ? `いま${n}人 — このモードのベスト人数です`
    : `いま${n}人 — 遊べますがベストは ${bestLabel(V.settings.mode)}。${m.note}`;
  $$("#optPack .chip").forEach((c) => c.classList.toggle("on", c.dataset.v === V.settings.pack));
  $("#optOyaBlock").hidden = !["oya", "mix"].includes(V.settings.mode);     // オヤメガネが出るモードのときだけ
  $$("#optOya .chip").forEach((c) => c.classList.toggle("on", c.dataset.v === (V.settings.oyaAnswer || "free")));
  $$("#optRounds .chip").forEach((c) => c.classList.toggle("on", Number(c.dataset.v) === V.settings.rounds));
  $("#startBtn").disabled = V.players.filter((p) => p.connected).length < 3;
  $("#startBtn").textContent = V.players.filter((p) => p.connected).length < 3 ? "あと " + (3 - V.players.filter((p) => p.connected).length) + " 人必要です" : "ゲーム開始";
}
$("#optPack").addEventListener("click", (e) => { const v = e.target.dataset?.v; if (v) emit("room:settings", { pack: v }); });
$("#optRounds").addEventListener("click", (e) => { const v = e.target.dataset?.v; if (v) emit("room:settings", { rounds: Number(v) }); });
$("#optOya").addEventListener("click", (e) => { const v = e.target.closest(".chip")?.dataset.v; if (v) emit("room:settings", { oyaAnswer: v }); });
$("#startBtn").addEventListener("click", () => emit("game:start", {}, (res) => {
  if (!res?.ok) { $("#lobbyErr").textContent = res.error; $("#lobbyErr").hidden = false; }
}));
/** 部屋を出てホームへ。ゲーム中・結果画面からも出られるように（前の部屋の席が残って新しい部屋に入れない問題） */
function leaveRoom() {
  if (socket.connected) socket.emit("room:leave", {});
  leftCode = V?.code || store.get().code || null;
  store.set({ token: null, code: null });
  V = null; resetRoomUi();
  $("#scoreSheet").hidden = true;
  history.replaceState(null, "", "./");
  show("home");
}
$("#leaveBtn").addEventListener("click", () => { if (confirm("この部屋を出ますか？")) leaveRoom(); });
$("#scoreLeave").addEventListener("click", () => {
  if (confirm("ゲームの途中ですが、この部屋を出ますか？（同じ名前で入り直せば席に戻れます）")) leaveRoom();
});
$("#endLeave").addEventListener("click", () => { if (confirm("この部屋を出てホームに戻りますか？")) leaveRoom(); });
$("#copyLink").addEventListener("click", async () => {
  const url = `${pageUrl()}?r=${V.code}`;
  try { await navigator.clipboard.writeText(url); toast("招待リンクをコピーしました"); }
  catch { prompt("このURLを送ってください", url); }
});

// ══════════ ゲーム画面 ══════════
const nameOf = (pid) => V.players.find((p) => p.id === pid)?.name || "？";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** ★名前をHTML文字列に埋め込むときは必ずこっち（名前にタグを入れられても画面に混ざらないように） */
const nameHtml = (pid) => esc(nameOf(pid));
const playerOf = (pid) => V.players.find((p) => p.id === pid);
const isHost = () => !!V.you?.isHost;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const topicFor = (name) => (V.topic ? V.topic.t.replace(/^あなたの/, `${name}の`).replace(/^あなた/, `${name}`) : "");

function renderHud() {
  $("#hudRound").textContent = `R${V.round}/${V.rounds}`;
  $("#hudMode").textContent = MODES[V.game]?.name || "";
  const plate = $("#topicPlate");
  plate.classList.toggle("hidden-topic", !!V.topicHidden);
  $("#topicKicker").textContent = V.topicHidden ? "お題は伏せられている" : "お題";
  $("#topicText").textContent = V.topicHidden ? "? ? ? ? ?" : V.topic ? V.topic.t : "—";
}

let timerRAF = null;
function runTimer() {
  cancelAnimationFrame(timerRAF);
  const box = $("#hudTimer");
  if (V.paused) { box.hidden = false; box.classList.remove("urgent"); box.querySelector("b").textContent = "停止中"; return; }
  if (!V.deadline) { box.hidden = true; return; }
  box.hidden = false;
  const tick = () => {
    if (!V?.deadline) { box.hidden = true; return; }
    const left = Math.max(0, V.deadline - (Date.now() - clockOffset));
    box.querySelector("b").textContent = Math.ceil(left / 1000);
    box.classList.toggle("urgent", left < 10000);
    timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

function layoutLineup() {
  const lineup = $("#lineup"), stage = $("#stage");
  const n = lineup.children.length;
  if (!n) return;
  // ★間隔と余白は CSS の実際の値を読む。決め打ち（横12px）だと実際の .8rem=12.8px との差で
  //   最後の1枚が次の行に押し出され、想定外の2行目ができて上下にはみ出していた（2026-09-28・9人で発覚）
  const ls = getComputedStyle(lineup), ss = getComputedStyle(stage);
  const px = (v) => parseFloat(v) || 0;
  const gapY = px(ls.rowGap), gapX = px(ls.columnGap), pad = px(ls.paddingTop);
  const stagePadY = px(ss.paddingTop) + px(ss.paddingBottom), stagePadX = px(ss.paddingLeft) + px(ss.paddingRight);
  const wide = window.innerWidth >= 720;
  // ★高さの取り分は「画面の一定割合」で固定する。フェーズごとにパネルの高さが変わっても
  //   カードの大きさが飛び跳ねないようにするため（実際のステージ高さより大きくはしない）
  const budgetH = Math.round(window.innerHeight * (wide ? 0.44 : 0.38));
  const availH = Math.min(stage.clientHeight - stagePadY, budgetH) - pad - 4;
  // ★幅は必ずステージから測る（lineup は前回の maxWidth で狭まっているので測ると縮み続ける）
  const availW = Math.min(stage.clientWidth - stagePadX, 980) - 2;
  // 列数はカードが一番大きくなる組み合わせを総当たりで選ぶ
  let best = { cw: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = Math.min((availW - gapX * (cols - 1)) / cols, ((availH - gapY * (rows - 1)) / rows) * 0.75);
    if (cw > best.cw) best = { cw, cols };
  }
  const cw = Math.max(40, Math.min(190, Math.floor(best.cw)));
  if (lineup.dataset.cw === String(cw) && lineup.dataset.cols === String(best.cols)) return;
  lineup.dataset.cw = cw;
  lineup.dataset.cols = best.cols;
  lineup.style.setProperty("--cw", cw + "px");
  // 折り返し位置を固定（幅が余ると勝手に1列多く詰めてしまうため）。小数の丸めで落ちないよう切り上げ＋余白
  lineup.style.maxWidth = Math.ceil(best.cols * cw + gapX * (best.cols - 1)) + 2 + "px";
  scope.refresh();
}
window.addEventListener("resize", () => { if (V && $("#screen-game").classList.contains("is-active")) layoutLineup(); });
// パネルの高さが変わるとステージの高さも変わるので、実寸が確定してから測り直す
new ResizeObserver(() => layoutLineup()).observe($("#stage"));

function buildLineup() {
  const lineup = $("#lineup");
  lineup.replaceChildren(...V.players.map((p) =>
    el("div", { class: "unit" + (p.connected ? "" : " off"), dataset: { pid: p.id, name: p.name } }, [
      el("div", { class: "halo" }, [el("span", { class: "halo-num", text: "" }), el("span", { class: "halo-unit", text: "" })]),
      el("div", { class: "card", onclick: () => onCardTap(p.id) }, [
        el("img", { src: avUrl(p.avatar), alt: "", loading: "lazy" }),
        el("div", { class: "card-scan" }),
        el("span", { class: "card-name", text: p.name }),
      ]),
    ])
  ));
  layoutLineup();
}

const unitOf = (pid) => $(`#lineup .unit[data-pid="${pid}"]`);
/** カード左上の札。1枚ずつ縦に積む（「YOU・対象」を1枚にすると狭いカードで2行に折れて顔に被っていた） */
function badge(pid, tags) {
  const u = unitOf(pid); if (!u) return;
  u.querySelector(".card-badges")?.remove();
  if (tags.length) u.querySelector(".card").prepend(el("span", { class: "card-badges" },
    tags.map((t) => el("span", { class: "card-badge" + (t === "YOU" ? " you" : ""), text: t }))));
}
function tick(pid, done) {
  const u = unitOf(pid); if (!u) return;
  let t = u.querySelector(".card-tick");
  if (!t) { t = el("span", { class: "card-tick", text: "" }); u.querySelector(".card").append(t); }
  t.classList.toggle("done", done);
  t.textContent = done ? "✓" : "…";
}
function clearTicks() { $$("#lineup .card-tick").forEach((t) => t.remove()); }

async function setHalo(pid, value, { unit = "", cls = "", roll = true } = {}) {
  const u = unitOf(pid); if (!u) return;
  const halo = u.querySelector(".halo");
  halo.className = "halo " + cls;
  halo.querySelector(".halo-unit").textContent = unit;
  u.classList.add("show-num");
  const num = halo.querySelector(".halo-num");
  if (roll && typeof value === "number") await rollNumber(num, value, { dur: 620, max: Math.max(20, (V.topic?.max || 100) * 0.5) });
  else num.textContent = typeof value === "number" ? fmt(value) : value;
}
function hideHalos() { $$("#lineup .unit").forEach((u) => u.classList.remove("show-num")); ui.shown.clear(); }

// カードタップ（ダレノスウジの割り当て / オヤメガネのヒント指名）
function onCardTap(pid) {
  if (!V) return;
  if (V.phase === "answer" && V.game === "match" && ui.selSlot) {
    if (ui.locked) return;
    if (pid === V.you.id) return toast("自分には自分の数字しか置けません");
    if (!V.parts.includes(pid)) return toast("この人は今回、数字を出していません（圏外）");
    for (const [sid, owner] of Object.entries(ui.assign)) if (owner === pid && sid !== V.my.mySlot) delete ui.assign[sid];
    ui.assign[ui.selSlot] = pid;
    ui.selSlot = null;
    paintAssign();
  } else if (V.phase === "scan" && V.game === "oya" && V.my.isOya && !V.stage.hint && pid !== V.you.id) {
    // ★スコープを動かすつもりのタップで、1回きりのヒントを使ってしまわないように
    if (!ui.hintPick) return;
    if (V.stage.values?.[pid] == null) return toast(`${nameOf(pid)} さんは数字を出していないので選べません`);
    ui.hintPick = false;
    repaintScanOya();
    emitAck("game:submit", { hintTo: pid });              // 「求めました」は、サーバーから届いた状態を見てから出す
  }
}

// ── パネル部品 ────────────────────────────────────────────
function sliderBlock(topic, initial) {
  const dkey = `${V.round}|${V.game}`;
  if (ui.draft?.key !== dkey) ui.draft = { key: dkey, value: null };   // ラウンドが変わったら下書きを捨てる
  const mid = Math.round((topic.min + topic.max) / 2 / topic.step) * topic.step;
  const snap = (v) => clampNum(Math.round(v / topic.step) * topic.step, topic.min, topic.max);
  ui.value = snap(initial ?? ui.draft.value ?? mid);

  const box = el("input", { class: "num-input", type: "number", min: topic.min, max: topic.max, step: topic.step, value: ui.value, inputmode: "numeric" });
  const range = el("input", { type: "range", min: topic.min, max: topic.max, step: topic.step, value: ui.value });
  const paint = (fromBox = false) => {
    const p = ((ui.value - topic.min) / (topic.max - topic.min)) * 100;
    range.style.setProperty("--fill", p + "%");
    range.value = ui.value;
    if (!fromBox) box.value = ui.value;
    ui.draft.value = ui.value;
  };
  const setVal = (v, fromBox = false) => { ui.value = snap(v); paint(fromBox); };
  range.addEventListener("input", () => setVal(Number(range.value)));
  box.addEventListener("input", () => { const n = Number(box.value); if (Number.isFinite(n) && box.value !== "") setVal(n, true); });
  box.addEventListener("blur", () => paint());
  const step = (dir) => el("button", { class: "step-btn", type: "button", text: dir > 0 ? "＋" : "−", onclick: () => setVal(ui.value + dir * topic.step) });
  const quick = [0, 0.1, 0.25, 0.5, 1].map((r) => {
    const v = snap(topic.min + (topic.max - topic.min) * r);
    return el("button", { class: "chip", type: "button", text: fmt(v), onclick: () => setVal(v) });
  });
  paint();
  return el("div", {}, [
    el("div", { class: "numbox" }, [step(-1), box, el("span", { class: "u", text: topic.unit }), step(1)]),
    el("div", { class: "slider-wrap" }, [el("small", { text: fmt(topic.min) }), range, el("small", { text: fmt(topic.max) })]),
    el("div", { class: "quick-row" }, quick),
  ]);
}

const waitCard = (txt) => el("p", { class: "panel-title", html: txt });
/** ホストの進行ボタン。confirmMsg（関数可）を返したら確認してから進める */
function hostBtn(label, cls = "btn btn-warn w-full", { confirmMsg } = {}) {
  if (!isHost()) return null;
  const builtKey = ui.panelKey, born = performance.now();
  return el("button", { class: cls, text: label, onclick: (e) => {
    const b = e.currentTarget;
    if (performance.now() - born < 350) return;             // 画面が切り替わった直後のタップ（連打の2打目）は無視
    if (ui.panelKey !== builtKey) return;                   // 古い画面に残ったボタン
    const msg = typeof confirmMsg === "function" ? confirmMsg() : confirmMsg;
    if (msg && !confirm(msg)) return;
    const seq = V.seq;                                      // ★押した時点の通し番号（一時停止・再開で番号が進んでも押せるように）
    lockBtn(b);
    emitAck("game:advance", { seq }, {
      onOk: () => setTimeout(() => { if (b.isConnected && ui.panelKey === builtKey) unlockBtn(b); }, 3000),   // 受け付けたのに進まなかった（一時停止など）
      onFail: () => unlockBtn(b),
    });
  } });
}
/** 入力を途中で締め切る前の確認（まだの人がいるときだけ） */
function earlyCloseMsg() {
  const need = V.game === "oya" ? V.players.filter((p) => p.connected && p.id !== V.targetId).length : V.players.filter((p) => p.connected).length;
  const left = Math.max(0, need - V.doneIds.length);
  if (!left) return null;
  const tgtMissing = (V.game === "gap" || V.game === "pita") && !V.stage.targetDone;
  return `まだ ${left} 人が入力中です。締め切って進めますか？\n` +
    (tgtMissing ? "（ターゲットがまだなので、このラウンドはスキップになります）" : "（間に合わなかった人は、このラウンドお休みになります）");
}
function earlyRevealMsg() {
  const left = V.parts.filter((id) => playerOf(id)?.connected && !V.doneIds.includes(id)).length;
  return left ? `まだ ${left} 人が解読中です。締め切って結果を出しますか？（まだの人は0点になります）` : null;
}

// ── フェーズごとのパネル ──────────────────────────────────
function panelTopic() {
  const m = MODES[V.game];
  const tgt = V.targetId ? nameOf(V.targetId) : "";
  const role = V.game === "oya" ? `今回の親は <b>${esc(tgt)}</b>` : V.game === "gap" || V.game === "pita" ? `今回のターゲットは <b>${esc(tgt)}</b>` : "全員参加";
  return [
    el("p", { class: "panel-title", html: `MODE ${V.round} / ${V.rounds}` }),
    modeIcon(V.game, "mode-badge"),
    el("div", { class: "topic-plate", style: "margin:0 0 .6rem" }, [
      el("span", { class: "topic-kicker", text: m.sub }),
      el("p", { class: "topic-text", text: m.name }),
    ]),
    el("p", { class: "result-line", text: m.desc }),
    el("p", { class: "result-line", html: role }),
    hostBtn("すぐ始める"),
  ];
}

function progressHtml() {
  const need = V.game === "oya" ? V.players.filter((p) => p.connected && p.id !== V.targetId).length : V.players.filter((p) => p.connected).length;
  return `<b>${V.doneIds.length}</b> / ${need} 人が入力ずみ`;
}

function panelInput() {
  const t = V.topic;
  const iAmTarget = V.you.id === V.targetId;
  const done = V.doneIds.includes(V.you.id);
  const prog = el("p", { class: "panel-title", id: "inProgress", html: progressHtml() });

  const early = () => hostBtn("待たずに進む", "btn btn-ghost w-full", { confirmMsg: earlyCloseMsg });
  if (V.game === "oya" && V.my.isOya) {
    return [waitCard("あなたは <b>親</b>。お題は伏せられています。<br>みんなの入力を待とう…"), prog, early()];
  }
  if (done) return [waitCard("送信ずみ。ほかの人を待っています…"), prog, early()];

  let title = "あなたの数字を入力";
  if (V.game === "gap" && !iAmTarget) title = `<b>${nameHtml(V.targetId)}</b> さんは何点だと思う？`;
  else if (V.game === "gap" && iAmTarget) title = "自己申告してください（あとで答え合わせ）";
  else if (V.game === "pita" && !iAmTarget) title = `<b>${nameHtml(V.targetId)}</b> さんの数字を予想`;
  else if (V.game === "pita" && iAmTarget) title = "あなたの本当の数字を入力";

  const sub = !iAmTarget && (V.game === "gap" || V.game === "pita") && /^あなた/.test(V.topic.t)
    ? el("p", { class: "result-line", text: topicFor(nameOf(V.targetId)) }) : null;
  const sendBtn = el("button", { class: "btn btn-primary btn-xl w-full", text: "この数字で送信", onclick: () => {
    lockBtn(sendBtn, "送信中…");
    emitAck("game:submit", { value: ui.value }, { onOk: () => { ui.sentAt = Date.now(); sendBtn.textContent = "送信しました"; }, onFail: () => unlockBtn(sendBtn) });
  } });
  // ★送信ボタンはパネルの下に貼り付ける（小さい画面でスクロールの下に隠れ、数字チップを押し間違えていた）
  return [waitCard(title), sub, sliderBlock(t, V.my.value), el("div", { class: "panel-actions stick" }, [sendBtn]), prog, early()];
}

async function panelScanMatch() {
  const slots = V.stage.slots || [];
  const strip = el("div", { class: "chipstrip" });
  const inRound = V.parts.includes(V.you.id);
  const outNames = V.players.filter((p) => !V.parts.includes(p.id)).map((p) => p.name);
  const out = [
    waitCard(inRound ? `<b>${slots.length}</b> 個の数字を受信…　あなたと、今回参加した ${slots.length - 1} 人の数字です`
      : `<b>${slots.length}</b> 個の数字を受信…　今回あなたは入力が間に合わなかったので <b>圏外</b>。見守ろう`),
    outNames.length ? el("p", { class: "result-line", text: `圏外: ${outNames.join("・")}` }) : null,
    strip,
    hostBtn("解読フェーズへ"),
  ];
  setTimeout(async () => {
    for (const s of slots) {
      strip.append(el("span", { class: "numchip" + (s.sid === V.my.mySlot ? " mine" : ""), text: fmt(s.value) }));
      await sleep(220);
    }
  }, 100);
  return out;
}

function repaintScanOya() {
  if (V?.phase === "scan" && V.game === "oya") $("#panel").replaceChildren(...panelScanOya().filter(Boolean));
}
function panelScanOya() {
  const hint = V.stage.hint;
  if (V.my.isOya) {
    const box = [waitCard("スコープをかざして、みんなの頭の上の数字を読み取ろう")];
    if (!hint) {
      if (ui.hintPick) box.push(el("p", { class: "result-line", text: "ヒントをもらう相手のカードをタップしてください" }));
      box.push(el("button", { class: "btn btn-ghost w-full", type: "button", text: ui.hintPick ? "やめる" : "💬 ヒントをもらう相手をえらぶ（1回だけ）",
        onclick: () => { ui.hintPick = !ui.hintPick; repaintScanOya(); } }));
    }
    else if (!hint.text) box.push(waitCard(`<b>${nameHtml(hint.to)}</b> さんがヒントを書いています…`));
    else box.push(el("p", { class: "note", text: `💬 ${nameOf(hint.to)}「${hint.text}」` }));
    // 親は自分のタイミングで回答へ進める（ホストが別の人でも待たされない）。背の低い画面でも隠れないよう下に貼り付ける
    box.push(el("div", { class: "panel-actions stick" }, [
      el("button", { class: "btn btn-primary btn-xl w-full", type: "button", text: "お題がわかった！答える", onclick: (e) => {
        const b = e.currentTarget;
        lockBtn(b);
        emitAck("game:submit", { ready: true }, { onFail: () => unlockBtn(b) });
      } }),
    ]));
    return box;
  }
  if (hint && hint.to === V.you.id && !hint.text) {
    const dk = `${V.round}|hint`;
    if (ui.hintDraft?.key !== dk) ui.hintDraft = { key: dk, text: "" };      // 作り直しで書きかけが消えないように
    const inp = el("input", { class: "input", maxlength: 40, placeholder: "例：毎日やってるよ" });
    inp.value = ui.hintDraft.text;
    inp.addEventListener("input", () => (ui.hintDraft.text = inp.value));
    return [
      waitCard("親からヒントを求められました！<br>お題と数字そのものは書かずに、ひとこと"),
      inp,
      el("div", { class: "panel-actions" }, [el("button", { class: "btn btn-primary w-full", text: "送る", onclick: (e) => {
        const b = e.currentTarget;
        if (!inp.value.trim()) return toast("ひとこと入れてください");
        lockBtn(b, "送信中…");
        emitAck("game:submit", { hintText: inp.value }, { onFail: () => unlockBtn(b) });
      } })]),
    ];
  }
  return [
    waitCard("親が数字を解析中…"),
    hint?.text ? el("p", { class: "note", text: `💬 ${nameOf(hint.to)}「${hint.text}」` }) : null,
    hostBtn("お題を推理する", "btn btn-ghost w-full"),
  ];
}

function paintAssign() {
  const slots = V.stage.slots || [];
  $$("#lineup .unit").forEach((u) => u.classList.toggle("pickable", !ui.locked && !!ui.selSlot && u.dataset.pid !== V.you.id && V.parts.includes(u.dataset.pid)));
  $$("#panel .numchip").forEach((c) => {
    const sid = c.dataset.sid;
    c.classList.toggle("on", ui.selSlot === sid);
    c.classList.toggle("used", !!ui.assign[sid]);
  });
  $$("#lineup .unit").forEach((u) => u.classList.remove("sel"));
  for (const [sid, pid] of Object.entries(ui.assign)) {
    const s = slots.find((x) => x.sid === sid);
    if (s) setHalo(pid, s.value, { unit: V.topic.unit, cls: "amber", roll: false });
  }
  $$("#lineup .unit").forEach((u) => {
    const assigned = Object.values(ui.assign).includes(u.dataset.pid);
    if (!assigned && u.dataset.pid !== V.you.id) u.classList.remove("show-num");
  });
  const sendBtn = $("#assignSend");
  if (sendBtn) {
    if (ui.locked) { sendBtn.disabled = true; sendBtn.textContent = V.my.assign ? "確定しました" : "送信中…"; return; }
    const need = slots.filter((s) => s.sid !== V.my.mySlot).length;
    const got = Object.keys(ui.assign).filter((sid) => sid !== V.my.mySlot).length;
    // ★途中でも確定できる（以前は全部埋めるまで押せず、時間切れで途中までの割り当てが全部0点になった）
    sendBtn.disabled = got === 0;
    sendBtn.textContent = got === 0 ? "数字をえらんで、人をタップ" : got < need ? `あと ${need - got} 個（このまま確定もOK）` : "この答えで確定";
  }
}

function panelAnswerMatch() {
  const slots = V.stage.slots || [];
  const dkey = `${V.round}|assign`;
  if (ui.assignKey !== dkey) { ui.assignKey = dkey; ui.assign = {}; ui.selSlot = null; }   // ラウンドが変わったら作り直し
  // ★入力に間に合わなかった人（圏外）は解読に参加できない。見守り画面にする
  if (!V.parts.includes(V.you.id)) {
    return [waitCard("今回は入力が間に合わなかったので <b>圏外</b>。みんなの解読を見守ろう"),
      hostBtn("待たずに結果へ", "btn btn-ghost w-full", { confirmMsg: earlyRevealMsg })];
  }
  if (V.my.assign) ui.assign = { ...V.my.assign };                        // 確定済みはサーバーの内容を復元
  if (V.my.mySlot) ui.assign[V.my.mySlot] = V.you.id;                     // 自分の数字は自分に固定
  ui.locked = !!V.my.assign;
  if (ui.locked || !slots.some((s) => s.sid === ui.selSlot)) ui.selSlot = null;   // 同じラウンドなら選んでいた数字を保つ
  const strip = el("div", { class: "chipstrip" }, slots.map((s) =>
    el("span", {
      class: "numchip" + (s.sid === V.my.mySlot ? " mine" : ""), dataset: { sid: s.sid }, text: fmt(s.value),
      onclick: () => {
        if (ui.locked) return;
        if (s.sid === V.my.mySlot) return toast("これはあなたの数字です");
        ui.selSlot = ui.selSlot === s.sid ? null : s.sid;
        paintAssign();
      },
    })
  ));
  const need = slots.filter((s) => s.sid !== V.my.mySlot).length;
  const submitAssign = (auto = false) => {
    if (ui.locked) return;
    const got = Object.keys(ui.assign).filter((sid) => sid !== V.my.mySlot).length;
    if (!got) return;
    if (!auto && got < need && !confirm(`まだ ${need - got} 個あいています。このまま確定しますか？（あいている分は0点）`)) return;
    ui.locked = true;
    const b = $("#assignSend");
    if (b) { b.disabled = true; b.textContent = auto ? "時間切れ前に自動で確定中…" : "送信中…"; }
    paintAssign();
    emitAck("game:submit", { assign: ui.assign }, {
      onOk: () => { const x = $("#assignSend"); if (x) x.textContent = "確定しました"; },
      onFail: () => { ui.locked = false; paintAssign(); },      // 届かなかったら割り当てはそのまま、押し直せるように
    });
  };
  const assignBtn = el("button", { id: "assignSend", class: "btn btn-primary btn-xl w-full", text: "この答えで確定", onclick: () => submitAssign(false) });
  // ★締め切り2.5秒前に、途中までの割り当てを自動で確定（時間切れで全部0点にならないように）
  clearTimeout(ui.autoTimer);
  const left = V.deadline ? V.deadline - (Date.now() - clockOffset) : 0;
  if (!ui.locked && left > 3000) {
    ui.autoTimer = setTimeout(() => {
      if (V?.phase === "answer" && V.game === "match" && ui.assignKey === dkey) submitAssign(true);
    }, left - 2500);
  }
  setTimeout(paintAssign, 30);
  return [
    waitCard(ui.locked ? "確定ずみ。ほかの人を待っています…" : "数字をえらんで → その数字だと思う人をタップ"),
    strip,
    el("div", { class: "panel-actions stick" }, [assignBtn]),
    hostBtn("待たずに結果へ", "btn btn-ghost w-full", { confirmMsg: earlyRevealMsg }),
  ];
}

// ── オヤメガネ自由回答 ────────────────────────────────────
const VERDICT = {
  ok: { mark: "◯", label: "正解", cls: "v-ok" },
  near: { mark: "△", label: "おしい", cls: "v-near" },
  ng: { mark: "✕", label: "ちがう", cls: "v-ng" },
};

/** 1回分の回答カード。判定が出ていれば「誰が何に入れたか」まで出す */
function attemptCard(a, i) {
  const v = a.verdict ? VERDICT[a.verdict] : null;
  const names = (k) => Object.entries(a.votes || {}).filter(([, x]) => x === k).map(([pid]) => nameOf(pid));
  return el("div", { class: "attempt " + (v ? v.cls : "") }, [
    el("div", { class: "attempt-head" }, [
      el("span", { class: "attempt-no", text: `${i + 1}回目` }),
      el("span", { class: "attempt-text", text: `「${a.text}」` }),
      el("span", { class: "attempt-verdict", text: v ? `${v.mark} ${v.label}` : "判定中…" }),
    ]),
    a.votes ? el("div", { class: "attempt-votes" }, ["ok", "near", "ng"].map((k) => {
      const who = names(k);
      return el("span", { class: "vote-chip " + VERDICT[k].cls, text: `${VERDICT[k].mark}${who.length}` + (who.length ? `　${who.join("・")}` : "") });
    })) : null,
  ]);
}

function panelAnswerOyaFree() {
  const ats = V.stage.attempts || [];
  const left = (V.stage.maxAttempts || 2) - ats.length;
  const history = ats.map(attemptCard);
  if (!V.my.isOya) {
    return [
      waitCard(ats.length ? `親がもう一度考え中…（のこり${left}回）` : "親が答えを考え中…"),
      hostBtn("待たずに結果へ", "btn btn-ghost w-full"),
      ...history,
    ];
  }
  const dkey = `${V.round}|oya|${ats.length}`;
  if (ui.oyaDraft?.key !== dkey) ui.oyaDraft = { key: dkey, text: "" };      // 回答ごとに下書きを分ける
  const inp = el("input", { class: "input guess-input", type: "text", maxlength: 40, placeholder: "例：スマホの通知の数", enterkeyhint: "send", autocomplete: "off" });
  inp.value = ui.oyaDraft.text;
  const guessBtn = el("button", { class: "btn btn-primary btn-xl w-full", type: "button", text: "この答えで判定してもらう" });
  const submitGuess = () => {
    const t = inp.value.trim();
    if (!t) return toast("答えを入力してください");
    if (guessBtn.disabled) return;                    // Enter と押下の二重送信を防ぐ
    lockBtn(guessBtn, "送信中…");
    emitAck("game:submit", { guess: t }, { onOk: () => (guessBtn.textContent = "送信しました"), onFail: () => unlockBtn(guessBtn) });
  };
  guessBtn.addEventListener("click", submitGuess);
  inp.addEventListener("input", () => (ui.oyaDraft.text = inp.value));
  // ★変換を確定する Enter では送らない（Safari は変換確定の Enter が compositionend のあとに keyCode 229 で来る）
  let composing = false;
  inp.addEventListener("compositionstart", () => (composing = true));
  inp.addEventListener("compositionend", () => (composing = false));
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || composing) return;
    e.preventDefault();
    submitGuess();
  });
  setTimeout(() => inp.focus(), 200);
  return [
    waitCard(ats.length ? `みんなの判定は「${VERDICT[ats[ats.length - 1].verdict]?.label || "—"}」。もう一回！（のこり${left}回）` : "頭の上の数字から、お題を当てよう"),
    ats.length ? null : el("p", { class: "result-line", text: "自分の言葉でOK。当たりかどうかは、お題を知っているみんなが判定します" }),
    inp,
    el("div", { class: "panel-actions stick" }, [guessBtn]),
    ...history,                                        // 前の回答は下へ（押すボタンがスクロールの下に隠れないように）
  ];
}

function judgeCountHtml() {
  return `<b>${V.doneIds.length}</b> / ${(V.stage.voterIds || []).length} 人が判定`;
}

function panelJudge() {
  const ats = V.stage.attempts || [];
  const cur = ats[ats.length - 1];
  const guess = el("div", { class: "guess-plate" }, [
    el("span", { class: "guess-kicker", text: `親（${nameOf(V.targetId)}）の答え ・ ${ats.length}回目` }),
    el("p", { class: "guess-text", text: `「${cur?.text || ""}」` }),
  ]);
  const count = el("p", { class: "panel-title", id: "judgeCount", html: judgeCountHtml() });
  const prev = ats.slice(0, -1).map(attemptCard);
  if (V.my.isOya) {
    return [guess, waitCard("お題を知っているみんなが判定中…"), count, hostBtn("判定を締め切る", "btn btn-ghost w-full"), ...prev];
  }
  const row = el("div", { class: "judge-row" }, ["ok", "near", "ng"].map((k) =>
    el("button", {
      class: "judge-btn " + VERDICT[k].cls, dataset: { v: k }, type: "button",
      onclick: () => {
        const prev = ui.pendingVote;
        ui.pendingVote = k; paintJudge();
        emitAck("game:submit", { vote: k }, { onFail: () => { ui.pendingVote = prev; paintJudge(); } });
      },
    }, [el("b", { text: VERDICT[k].mark }), el("span", { text: VERDICT[k].label })])
  ));
  setTimeout(paintJudge, 0);
  return [
    guess,
    el("p", { class: "result-line" }, ["正解のお題：", el("b", { text: V.topic?.t || "" })]),
    row,
    el("p", { class: "result-line judge-hint", text: "言い回しが違っても、意味が合っていれば◯。判定結果は誰が何に入れたかまで公開されます" }),
    count,
    hostBtn("判定を締め切る", "btn btn-ghost w-full"),
    ...prev,                                           // 前の回答は下へ（2回目の判定ボタンが隠れないように）
  ];
}

/** 判定パネルは作り直さずに、人数と自分の票だけ塗り直す */
function paintJudge() {
  const c = $("#judgeCount");
  if (c) c.innerHTML = judgeCountHtml();
  const mine = V.my.vote || ui.pendingVote || null;
  $$("#panel .judge-btn").forEach((b) => b.classList.toggle("on", b.dataset.v === mine));
}

function panelAnswerOya() {
  if (V.stage.oyaMode === "free") return panelAnswerOyaFree();
  const ch = V.stage.choices || [];
  if (!V.my.isOya) return [waitCard("親が4択で回答中…"), el("div", { class: "choices" }, ch.map((c) => el("button", { class: "choice", text: c.t, disabled: true })))];
  return [
    waitCard("頭の上の数字から、お題を当てよう"),
    el("div", { class: "choices" }, ch.map((c) =>
      el("button", { class: "choice", text: c.t, onclick: (e) => {
        const b = e.currentTarget;
        [...b.parentElement.children].forEach((x) => (x.disabled = true));
        emitAck("game:submit", { pick: c.id }, { onFail: () => [...b.parentElement.children].forEach((x) => (x.disabled = false)) });
      } })
    )),
  ];
}

// ── 結果表示 ──────────────────────────────────────────────
function gainsList(log) {
  const gains = log?.gains || {};
  const rows = V.players.filter((p) => p.connected).map((p) => ({ p, g: gains[p.id] || 0 })).sort((a, b) => b.g - a.g);
  return el("ul", { class: "tally" }, rows.map(({ p, g }) =>
    el("li", {}, [el("img", { src: avUrl(p.avatar), alt: "" }), el("span", { text: p.name }), el("span", { class: "g" + (g ? "" : " zero"), text: (g ? "+" : "") + g })])
  ));
}

async function revealMatch(log) {
  const slots = V.stage.slots || [];
  hideHalos();
  await sleep(300);
  const pace = Math.max(340, 780 - slots.length * 45);   // 人数が多いほどテンポを上げる
  await scope.autoScan(slots.map((s) => s.owner), {
    dwell: pace, travel: Math.max(320, pace - 150),
    onArrive: async (pid) => {
      const s = slots.find((x) => x.owner === pid);
      await setHalo(pid, s.value, { unit: V.topic.unit, cls: "" });
    },
  });
  const d = log?.details || {};
  const best = Object.entries(d).sort((a, b) => b[1].correct - a[1].correct)[0];
  return [
    el("p", { class: "result-line", html: best ? `最多的中は <b>${nameHtml(best[0])}</b>（${best[1].correct}人）` : "" }),
    log?.notes?.length ? el("p", { class: "note", text: log.notes[0] }) : null,
  ];
}

async function revealGap(log) {
  const t = V.topic, tid = V.targetId;
  hideHalos();
  await scope.autoScan([tid], { dwell: 500, travel: 460, onArrive: async () => { await setHalo(tid, log.avg, { unit: "平均", cls: "amber" }); } });
  await sleep(600);
  const flip = (v) => (v > 68 ? " flip" : "");     // 右端に寄るとラベルが切れるので内側へ出す
  const bar = el("div", { class: "gapbar" }, [
    el("div", { class: "gapbar-fill", style: `width:${log.avg}%` }),
    el("div", { class: "gapbar-mark" + flip(log.avg), style: `left:${log.avg}%` }, [el("span", { text: `みんな ${log.avg}` })]),
    el("div", { class: "gapbar-mark cy" + flip(log.self), style: `left:${log.self}%` }, [el("span", { text: `本人 ${log.self}` })]),
  ]);
  setTimeout(() => setHalo(tid, log.self, { unit: "自己申告", cls: "", roll: false }), 900);
  return [
    el("p", { class: "result-line", html: `<b>${nameHtml(tid)}</b> の${t.t.replace(/^あなたの/, "")}` }),
    bar,
    el("p", { class: "note", text: `ギャップ ${log.gap} ／ ${log.notes[0]}` }),
  ];
}

async function revealPita(log) {
  const tid = V.targetId, t = V.topic;
  hideHalos();
  await scope.autoScan([tid], { dwell: 600, travel: 460, onArrive: async () => { await setHalo(tid, log.real, { unit: t.unit, cls: "amber" }); } });
  const rows = Object.entries(log.guesses).map(([pid, v]) => ({ pid, v, d: Math.abs(v - log.real) })).sort((a, b) => a.d - b.d);
  for (const r of rows) setHalo(r.pid, r.v, { unit: t.unit, cls: r.d === 0 ? "amber" : "", roll: false });
  return [
    el("p", { class: "result-line", html: `<b>${nameHtml(tid)}</b> の答えは <b>${fmt(log.real)}</b> ${t.unit}` }),
    el("ul", { class: "tally" }, rows.map((r) =>
      el("li", {}, [
        el("img", { src: avUrl(playerOf(r.pid)?.avatar), alt: "" }),
        el("span", { text: nameOf(r.pid) }),
        el("span", { class: "g" + (r.d === 0 ? "" : " zero"), text: `${fmt(r.v)}（差 ${fmt(r.d)}）` }),
      ])
    )),
    el("p", { class: "note", text: log.notes[0] }),
  ];
}

async function revealOya(log) {
  const ch = V.stage.choices || [];
  Object.entries(V.stage.values || {}).forEach(([pid, v]) => setHalo(pid, v, { unit: V.topic?.unit || "", cls: "", roll: false }));
  if (log.mode === "free") {
    const v = log.verdict ? VERDICT[log.verdict] : null;
    return [
      el("div", { class: "guess-plate reveal-topic " + (v ? v.cls : "v-ng") }, [
        el("span", { class: "guess-kicker", text: v ? `判定 ${v.mark} ${v.label}` : "時間切れ" }),
        el("p", { class: "guess-text", text: V.topic?.t || "" }),
      ]),
      ...(log.attempts || []).map(attemptCard),
      log.hint?.text ? el("p", { class: "result-line", text: `💬 ${nameOf(log.hint.to)}「${log.hint.text}」` }) : null,
      el("p", { class: "note", text: log.notes[0] }),
    ];
  }
  return [
    el("p", { class: "result-line", html: log.ok ? `親の <b>${nameHtml(V.targetId)}</b> が正解！　全員に得点` : `残念、不正解。正解は…` }),
    el("div", { class: "choices" }, ch.map((c) =>
      el("button", { class: "choice" + (c.id === V.stage.answerId ? " correct" : c.id === log.pick ? " wrong" : ""), text: c.t, disabled: true })
    )),
    log.hint?.text ? el("p", { class: "result-line", text: `💬 ${nameOf(log.hint.to)}「${log.hint.text}」` }) : null,
    el("p", { class: "note", text: log.notes[0] }),
  ];
}

let revealGen = 0;
async function panelReveal() {
  const gen = ++revealGen;
  const alive = () => gen === revealGen && V && V.phase === "reveal";
  const log = V.log || {};
  const panel = $("#panel");
  panel.replaceChildren(waitCard("解析中…"));
  const run = async () => {
    if (log.skipped) return [el("p", { class: "note", text: log.reason || "このラウンドはスキップされました" })];
    if (V.game === "match") return await revealMatch(log);
    if (V.game === "gap") return await revealGap(log);
    if (V.game === "pita") return await revealPita(log);
    if (V.game === "oya") return await revealOya(log);
    return [];
  };
  let head = [], guard = null;
  try {
    // 演出が何かの理由で終わらなくても、20秒で必ず結果を出す（「解析中…」で固まらせない）
    const timeout = new Promise((res) => { guard = setTimeout(() => res([]), 20000); });
    head = (await Promise.race([run(), timeout])) || [];
  } catch (e) { console.error(e); }
  clearTimeout(guard);                               // ★終わったら解除（次ラウンドのスコープを消さない）
  if (!alive()) return;                              // 途中で次へ進んでいたら何もしない
  scope.disable();
  const last = V.round >= V.rounds;
  panel.replaceChildren(
    ...head.filter(Boolean),
    gainsList(log),
    el("div", { class: "panel-actions reveal-act" }, [hostBtn(last ? "最終結果へ" : "次のラウンドへ", "btn btn-primary btn-xl w-full") || el("p", { class: "panel-title", text: "ホストの操作を待っています…" })])
  );
}

// ── ゲーム画面の描画 ──────────────────────────────────────
async function renderGame() {
  renderHud();
  runTimer();
  $("#scopeToggle").hidden = !["scan", "answer", "judge", "reveal"].includes(V.phase);

  // ★カードは顔ぶれ（id の並び）が変わったときだけ作り直す。誰かが切れた・戻っただけなら印を付け替えるだけ
  //   （以前は1人の出入りのたびに全員のパネルが作り直され、書きかけのヒント・選んだ数字・キーボードが消えた）
  const lineKey = V.players.map((p) => p.id).join(",");
  if (lineKey !== ui.lineKey) { ui.lineKey = lineKey; buildLineup(); ui.panelKey = ""; ui.phaseKey = ""; ui.revealKey = ""; ui.shown.clear(); }
  else V.players.forEach((p) => {
    const u = unitOf(p.id); if (!u) return;
    u.classList.toggle("off", !p.connected);
    if (!p.connected) u.querySelector(".card-tick")?.remove();   // 抜けた人に「…」「✓」を残さない
  });

  const h = V.stage?.hint;
  const nAttempts = (V.stage?.attempts || []).length;
  const key = [V.round, V.game, V.phase, nAttempts, h ? `${h.to}:${h.text ? 1 : 0}` : "-", V.you?.isHost ? "host" : "-"].join("|");
  const fresh = key !== ui.panelKey;
  // ★フェーズが変わったか（ヒントの依頼・受信やホスト交代だけなら false）。読み取った数字・印・下書きを消すのはこちらのときだけ
  //   （以前はヒントを頼んだ瞬間に、親がスコープで読み取った数字が全部消えていた）
  const phaseKey = [V.round, V.game, V.phase, nAttempts].join("|");
  const phaseChanged = phaseKey !== ui.phaseKey;
  if (fresh) {
    ui.panelKey = key;
    ui.pendingVote = null;
    if (phaseChanged) {
      ui.phaseKey = phaseKey;
      ui.sent = false;
      ui.sentAt = 0;
      ui.hintPick = false;
      clearTimeout(ui.autoTimer);
      $("#panel").scrollTop = 0;                      // 前のフェーズのスクロール位置を持ち越さない
    }
    // 役割バッジ
    $$("#lineup .card-badges").forEach((b) => b.remove());
    for (const p of V.players) {
      const tags = [];
      if (p.id === V.you?.id) tags.push("YOU");
      // ダレノスウジは「対象者」がいないゲームなのでバッジを出さない（誤解のもと）
      if (p.id === V.targetId && V.game !== "match") tags.push(V.game === "oya" ? "親" : "対象");
      const outOfRound = V.game === "match" && ["scan", "answer", "reveal"].includes(V.phase) && !V.parts.includes(p.id);
      unitOf(p.id)?.classList.toggle("out", outOfRound);
      if (outOfRound) tags.push("圏外");
      badge(p.id, tags);
    }
    if (phaseChanged) {
      clearTicks();
      if (V.phase !== "reveal") hideHalos();
    }
    if (V.phase !== "scan" && !(V.phase === "reveal")) scope.disable();
  }

  const panel = $("#panel");
  if (V.phase === "input") {
    V.players.filter((p) => p.connected).forEach((p) => { if (!(V.game === "oya" && p.id === V.targetId)) tick(p.id, V.doneIds.includes(p.id)); });
    // 自分の数字は自分だけ見えている
    if (V.my.value != null) setHalo(V.you.id, V.my.value, { unit: V.topic.unit, cls: "", roll: false });
    const done = V.doneIds.includes(V.you.id);
    // ★「送信しました」なのにサーバーでは未送信のまま5秒 → 押し直せるように作り直す（保険）
    const stuck = !done && ui.sentAt && Date.now() - ui.sentAt > 5000;
    if (fresh || done !== ui.sent || stuck) { ui.sent = done; ui.sentAt = 0; panel.replaceChildren(...panelInput().filter(Boolean)); }
    const pg = $("#inProgress"); if (pg) pg.innerHTML = progressHtml();   // スライダーを壊さずに人数だけ更新
    return;
  }
  if (V.phase === "answer" && V.game === "match") {
    V.players.filter((p) => p.connected).forEach((p) => tick(p.id, V.doneIds.includes(p.id)));
  }
  if (V.phase === "judge") {
    // 判定中：数字は出したまま、判定済みの人にチェック。パネルは入った時だけ作り、以降は塗り直し
    V.players.filter((p) => p.connected && p.id !== V.targetId).forEach((p) => tick(p.id, V.doneIds.includes(p.id)));
    if (fresh) {
      Object.entries(V.stage.values || {}).forEach(([pid, v]) => setHalo(pid, v, { unit: V.topic?.unit || "", cls: "", roll: false }));
      panel.replaceChildren(...panelJudge().filter(Boolean));
    } else {
      paintJudge();
    }
    return;
  }
  if (!fresh) return;

  if (V.phase === "topic") { panel.replaceChildren(...panelTopic().filter(Boolean)); return; }
  if (V.phase === "scan") {
    if (V.game === "match") panel.replaceChildren(...(await panelScanMatch()).filter(Boolean));
    else {
      if (V.my.isOya && h && !h.text && ui.hintToastFor !== `${V.round}|${h.to}`) {   // サーバーが受け付けてから知らせる
        ui.hintToastFor = `${V.round}|${h.to}`;
        toast(`${nameOf(h.to)} さんにヒントを求めました`);
      }
      panel.replaceChildren(...panelScanOya().filter(Boolean));
      if (V.my.isOya) {
        scope.enable({ onLock: (pid) => { if (pid && V.stage.values?.[pid] != null && !ui.shown.has(pid)) { ui.shown.add(pid); setHalo(pid, V.stage.values[pid], { unit: V.topic?.unit || "", cls: "" }); } } });
      } else {
        Object.entries(V.stage.values || {}).forEach(([pid, v]) => setHalo(pid, v, { unit: V.topic.unit, cls: "", roll: false }));
      }
    }
    return;
  }
  if (V.phase === "answer") {
    if (V.game === "match") panel.replaceChildren(...panelAnswerMatch().filter(Boolean));
    else {
      Object.entries(V.stage.values || {}).forEach(([pid, v]) => setHalo(pid, v, { unit: "", cls: "", roll: false }));
      panel.replaceChildren(...panelAnswerOya().filter(Boolean));
    }
    return;
  }
  if (V.phase === "reveal") {
    const rk = `${V.round}|${V.game}`;
    if (ui.revealKey !== rk) { ui.revealKey = rk; panelReveal(); }
    else {                                             // ホストが替わっただけ：演出は流し直さず、下のボタンだけ差し替える
      const act = $("#panel .reveal-act");
      if (act) act.replaceChildren(hostBtn(V.round >= V.rounds ? "最終結果へ" : "次のラウンドへ", "btn btn-primary btn-xl w-full") || el("p", { class: "panel-title", text: "ホストの操作を待っています…" }));
    }
    return;
  }
}

// ── スコアシート ──────────────────────────────────────────
function renderScores() {
  const rows = V.players.slice().sort((a, b) => b.score - a.score);
  let rk = 0, prev = null;
  $("#scoreList").replaceChildren(...rows.map((p, i) => {
    if (p.score !== prev) { rk = i + 1; prev = p.score; }
    return el("li", { class: p.id === V.you?.id ? "me" : "" }, [
      el("span", { class: "rk", text: rk }),
      el("img", { src: avUrl(p.avatar), alt: "" }),
      el("span", { text: p.name }),
      el("span", { class: "sc", text: fmt(p.score) }),
    ]);
  }));
}
$("#scoreBtn").addEventListener("click", () => { renderScores(); $("#scoreSheet").hidden = false; });
$("#scoreClose").addEventListener("click", () => ($("#scoreSheet").hidden = true));
$("#scopeToggle").addEventListener("click", () => {
  scope.toggle({ onLock: (pid) => {
    if (!pid) return;
    const v = V?.stage?.values?.[pid];
    if (v != null && !ui.shown.has(pid)) { ui.shown.add(pid); setHalo(pid, v, { unit: V.topic?.unit || "", cls: "" }); }
  } });
});

// ── 最終結果 ──────────────────────────────────────────────
function renderEnd() {
  const r = V.ranking || [];
  $("#podium").replaceChildren(...r.map((p) =>
    el("li", { class: p.rank === 1 ? "top" : "" }, [
      el("span", { class: "rk", text: p.rank }),
      el("img", { src: avUrl(p.avatar), alt: "" }),
      el("span", { class: "nm", text: p.name }),
      el("span", { class: "sc", text: fmt(p.score) }),
    ])
  ));
  $("#againBtn").hidden = !isHost();
}
$("#againBtn").addEventListener("click", () => emit("game:again"));
$("#shareBtn").addEventListener("click", async () => {
  const tops = (V.ranking || []).filter((r) => r.rank === 1);
  const who = tops.map((t) => t.name).join("・") || "？";
  const text = `スキャナンで遊んだ！${tops.length > 1 ? "同率優勝" : "優勝"}は ${who}（${fmt(tops[0]?.score ?? 0)}点）\n頭の上の数字、見えてます。`;
  const url = pageUrl();
  if (navigator.share) { try { await navigator.share({ title: "スキャナン", text, url }); return; } catch {} }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("結果をコピーしました"); } catch {}
});

// ── 遊び方シート ──────────────────────────────────────────
$("#howtoModes").replaceChildren(...["match", "gap", "pita", "oya"].flatMap((k) => [
  el("dt", { text: MODES[k].name }), el("dd", { text: MODES[k].desc }),
]));
$("#howtoBtn").addEventListener("click", () => ($("#howtoSheet").hidden = false));
$("#howtoClose").addEventListener("click", () => ($("#howtoSheet").hidden = true));

// ── ソケット ──────────────────────────────────────────────
// ★同期ズレ対策3: 画面復帰・フォーカス・オンライン復帰・12秒ごとに resync（room:rejoin は何度呼んでも安全）
let superseded = false;      // 別タブ・別端末に席を取られて待機中
let lastRecycleAt = 0;
let lastRxAt = Date.now();   // サーバーから最後に何か届いた時刻（返事・state・ping）
socket.io.on("packet", () => (lastRxAt = Date.now()));
socket.io.on("ping", () => (lastRxAt = Date.now()));

/** watch=true のときだけウォッチドッグを動かす（画面に戻ったとき・送信に失敗したとき）。
 *  ★以前は12秒ごとの resync でも「2.5秒以内に state が来なければ張り直し」をしていて、遅いだけの回線を
 *    12秒おきに自分で切り、そのたびにサーバーが離脱扱い→入力の締め切りやパネルの作り直しが起きていた */
function resync(watch = false) {
  const s = store.get();
  if (!s.token || !s.code || superseded) return;
  if (!socket.connected) { socket.connect(); return; }   // 再接続の待ち時間を飛ばして即つなぐ
  const sentAt = Date.now();
  let acked = false;
  socket.emit("room:rejoin", { code: s.code, token: s.token }, (res) => {
    acked = true;
    if (res?.ok) { me = { code: res.code, token: res.token, id: res.id }; return; }
    if (res?.gone) roomGone();
  });
  if (!watch) return;
  // ★ゾンビ接続のウォッチドッグ：返事も ping も何も届かない「つながってるつもり」の接続だけ作り直す
  setTimeout(() => {
    if (acked || lastRxAt > sentAt) return;             // 何か届いた＝遅いだけで生きている
    if (!superseded && store.get().token && socket.connected &&
        document.visibilityState === "visible" && Date.now() - lastRecycleAt > 15000) {
      lastRecycleAt = Date.now();
      socket.disconnect().connect();
    }
  }, 5000);
}
/** 部屋が消えていた（サーバー再起動・時間切れ）。読み込み直して最新の画面でホームへ */
function roomGone() {
  store.set({ token: null, code: null });
  let why = "部屋が終了していました";
  try { if (sessionStorage.getItem("scanan.restarted")) { why = "サーバーの更新で部屋が終了しました。お手数ですが作り直してください"; sessionStorage.removeItem("scanan.restarted"); } } catch {}
  // ★読み込み直す（古い JS のまま遊び続けるのを防ぐ）。保存が効かない端末は読み込み直すと無限に繰り返すので、その場でホームへ
  if (!store.get().token) {
    try { sessionStorage.setItem("scanan.toast", why); location.replace("./"); return; } catch {}
  }
  V = null; resetRoomUi();
  history.replaceState(null, "", "./");
  show("home");
  toast(why, 5000);
}
socket.on("connect", () => { netUp(); resync(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resync(true); });
window.addEventListener("focus", () => resync(true));
window.addEventListener("online", () => resync(true));
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  resync();
}, 12000);

// ── 通信が切れたときの表示（すぐ戻る切断でちらつかないよう1.5秒たってから出す） ──
let netDownAt = 0, netShown = false, netTimer = null;
function netDown() {
  if (!store.get().token || superseded || netDownAt) return;
  netDownAt = Date.now();
  netTimer = setTimeout(() => {
    if (!netDownAt || superseded) return;
    netShown = true;
    $("#netBar").hidden = false;
  }, 1500);
}
function netUp() {
  clearTimeout(netTimer);
  const was = netShown;
  netDownAt = 0; netShown = false;
  $("#netBar").hidden = true;
  if (was) toast("つながりました！");
}
/** 切れている間は送らずに知らせる（送信待ちのまま再接続すると、部屋に入り直す前に届いて無視されるため）
 *  ★名前は emit。send だと送信ボタンの変数名とぶつかって、押しても何も起きない（2026-09-28に踏んだ） */
function emit(ev, payload, cb) {
  if (!socket.connected) return toast("📡 つながってから、もう一度押してね");
  socket.emit(ev, payload, cb);
}

/** 送って、サーバーが「受け取った」と返すのを待つ。6秒返事がなければ失敗として onFail（＝ボタンを押せる状態に戻す）。
 *  ★以前は押した瞬間にボタンを「送信しました」で固めていたので、通信が一瞬切れていたり、
 *    接続の張り直し中で部屋に入り直す前だったりすると、送れていないのに押し直せなくなっていた */
function emitAck(ev, payload, { onOk, onFail } = {}) {
  if (!socket.connected) { toast("📡 つながってから、もう一度押してね"); onFail?.(); return false; }
  socket.timeout(6000).emit(ev, payload, (err, res) => {
    if (err) { toast("📡 送れませんでした。もう一度押してね"); resync(true); onFail?.(); return; }
    if (!res?.ok) {
      toast(res?.error || "受け付けられませんでした。もう一度押してね");
      if (res?.rejoin) resync();                    // 部屋に入り直す前だった → 入り直してから押し直してもらう
      onFail?.(res);
      return;
    }
    onOk?.(res);
  });
  return true;
}
const lockBtn = (b, label) => { b.disabled = true; b.dataset.label = b.dataset.label || b.textContent; if (label) b.textContent = label; };
const unlockBtn = (b) => { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; };

socket.on("disconnect", (reason) => {
  // サーバーから切られた＝別のタブ・端末が同じ席で入ってきた（タブ複製など）。
  // 黙って奪い返すと2画面が数秒おきに席を取り合うので、待機画面を出して手で選んでもらう
  if (reason === "io server disconnect" && store.get().token) {
    superseded = true;
    netUp();
    $("#takeoverSheet").hidden = false;
    return;
  }
  netDown();
});
socket.on("connect_error", () => netDown());

// ★サーバーが入れ替わった（新しい版を出した・Cloudflare が起こし直した＝部屋は消えている）ことは、つなぎ直したときの boot の違いで知る。
//   Render のときは止まる前に "server:restart" が届いていたが、Cloudflare は知らせてくれないので（部屋が消えていたときの説明に使う）
let serverBoot = "";
// ★サーバーが新しい版になっていたら読み込み直す（古いJSのまま遊び続けて「一部の人だけ送れない」を防ぐ）。
//   同じ版には1回だけ（読み込み直しのループ防止）
socket.on("hello", ({ build, boot } = {}) => {
  if (boot && serverBoot && boot !== serverBoot) { try { sessionStorage.setItem("scanan.restarted", "1"); } catch {} }
  if (boot) serverBoot = boot;
  if (!build || !MY_BUILD || MY_BUILD === "__BUILD__" || build === MY_BUILD) return;
  try {
    if (sessionStorage.getItem("scanan.reloadedFor") === build) return;
    sessionStorage.setItem("scanan.reloadedFor", build);
  } catch { return; }
  location.reload();
});
// ★サーバーが再起動する直前の予告（デプロイなど）
socket.on("server:restart", () => {
  try { sessionStorage.setItem("scanan.restarted", "1"); } catch {}
  toast("サーバーを更新しています。すぐ戻ります（部屋は作り直しになります）", 6000);
});
$("#retakeBtn").addEventListener("click", () => {
  superseded = false;
  $("#takeoverSheet").hidden = true;
  socket.connect();                                   // connect → resync で席を取り返す
});
$("#takeoverHomeBtn").addEventListener("click", () => {
  superseded = false;
  $("#takeoverSheet").hidden = true;
  leftCode = V?.code || store.get().code || null;
  store.set({ token: null, code: null });
  V = null; resetRoomUi();
  history.replaceState(null, "", "./");
  show("home");
});
socket.on("kicked", () => { leftCode = V?.code || null; store.set({ token: null, code: null }); V = null; resetRoomUi(); toast("部屋から退出しました"); show("home"); });
socket.on("state", (v) => {
  if (leftCode && v.code === leftCode) return;       // 出た部屋から遅れて届いた state（出る前に配られたもの）
  clockOffset = Date.now() - v.now;
  const prevPhase = V?.phase;
  // 入力が締め切られたのに自分は送っていなかった → 「送れなかった」と思わないように知らせる。
  // ★判定は締め切り後の参加者（parts）で。最後に送った人は、自分が入った input の state を受け取らないまま次へ進むため
  if (V && V.phase === "input" && v.phase !== "input" && v.round === V.round && !["lobby", "end"].includes(v.phase) &&
      !(v.parts || []).includes(V.you?.id) && !v.log?.skipped &&
      !V.doneIds.includes(V.you?.id) && !(V.game === "oya" && V.my?.isOya)) {
    toast("入力が締め切られました（このラウンドはお休み）", 3500);
  }
  if (v.paused && !V?.paused) toast("つながっている人が2人未満なので一時停止中。戻ってきたら続きから再開します", 5000);
  V = v;
  if (v.phase === "lobby") { if (prevPhase && prevPhase !== "lobby") resetRoomUi(); show("lobby"); renderLobby(); }
  else if (v.phase === "end") { show("end"); renderEnd(); }
  else { show("game"); renderGame(); }
});

// ── 起動 ──────────────────────────────────────────────────
(function boot() {
  const s = store.get();
  if (s.name) draft.name = s.name;
  if (s.avatar) draft.avatar = s.avatar;
  buildAvatars();
  $("#inName").value = draft.name;
  try { const t = sessionStorage.getItem("scanan.toast"); if (t) { sessionStorage.removeItem("scanan.toast"); setTimeout(() => toast(t, 5000), 300); } } catch {}
  const r = new URLSearchParams(location.search).get("r");
  // ★前の部屋の席が残っていても、別の部屋の招待リンクで開いたら新しい部屋を優先する
  if (r && s.token && s.code && r.toUpperCase().slice(0, 4) !== s.code) { store.set({ token: null, code: null }); s.token = null; }
  if (r) {
    $("#inCode").value = r.toUpperCase().slice(0, 4);
    draft.mode = "join";
    $("#setupTitle").textContent = "合言葉で参加";
    $("#codeField").hidden = false;
    if (!s.token) show("setup");
  }
})();
