"use strict";
/* Cube Bot 入口ページ。
   接続先は iMac の Bot サーバー (8103) を Tailscale Serve (8444、
   tailnet 内のみ) 経由で叩く。Cube の cube-server (8443) と同じ型。
   依頼は POST /task で即 job_id が返り、GET /task/<id> をポーリング
   して進捗と結果を表示する (モデル起動と生成で数分かかるため)。
   確認ゲート: state が needs_confirm になったら確認ボタンを出し、
   承認時のみ POST /task/<id>/confirm を送る。
   2026-11-24: Muse アプリ風 UI に合わせて、吹き出し構造・履歴・
   キャラ状態表示を追加した。API の呼び出し仕様は従来どおり。 */
const BOT_BASE_URL = "https://imac.tail9ed76a.ts.net:8444";

const listEl = document.getElementById("msg-list");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const scrollEl = document.getElementById("chat-scroll");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const historyListEl = document.getElementById("history-list");
const historyEmptyEl = document.getElementById("history-empty");
const historySearchEl = document.getElementById("history-search");
const sidebarEl = document.getElementById("sidebar");
const scrimEl = document.getElementById("scrim");
const charWrap = document.getElementById("char-wrap");
const charImg = document.getElementById("char-img");
const charFallback = document.getElementById("char-fallback");
const charChip = document.getElementById("char-chip");
const plusBtn = document.getElementById("plus-btn");
const plusPanel = document.getElementById("plus-panel");

function scrollDown() {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

/* ---- キャラ（上部に常駐。状態でアニメーションとチップが変わる） ----
   idle: ゆっくり揺れる / thinking: 考え中（速い揺れ） /
   working: 作業中（速い揺れ） / confirm: 確認待ち /
   done: 完了（軽く跳ねてから idle へ） / error: エラー表示。 */
let charSeq = 0;
let charRevertTimer = null;

function setCharState(state, label, seq) {
  if (typeof seq === "number" && seq !== charSeq) return;
  charWrap.className = "char-wrap char-" + state;
  charChip.textContent = label;
  if (charRevertTimer) {
    clearTimeout(charRevertTimer);
    charRevertTimer = null;
  }
  if (state === "done" || state === "error") {
    const mySeq = charSeq;
    charRevertTimer = setTimeout(() => {
      if (charSeq === mySeq) setCharState("idle", "待機中");
    }, 4200);
  }
}

/* キャラ画像（Cube 2D キャラ C案）。char_frames.js の CubeBotCharFrames
   （base / blink）を使う。読み込めなければキューブの SVG のまま。 */
(function initCharImage() {
  const frames = window.CubeBotCharFrames;
  if (!frames || !frames.base) return;
  charImg.src = frames.base;
  charImg.hidden = false;
  charFallback.hidden = true;
  if (frames.blink) {
    const blink = () => {
      if (!charImg.hidden) {
        charImg.src = frames.blink;
        setTimeout(() => {
          charImg.src = frames.base;
        }, 150);
      }
      setTimeout(blink, 3200 + Math.random() * 2600);
    };
    setTimeout(blink, 2400 + Math.random() * 1600);
  }
})();

/* ---- サイドバー（狭い画面ではハンバーガーで開閉） ---- */
function openSidebar() {
  sidebarEl.classList.add("open");
  scrimEl.hidden = false;
}
function closeSidebar() {
  sidebarEl.classList.remove("open");
  scrimEl.hidden = true;
}
document.getElementById("menu-btn").addEventListener("click", openSidebar);
scrimEl.addEventListener("click", closeSidebar);

/* ---- 履歴（この会話で送った依頼の一覧。クリックで該当発言へ） ---- */
function addHistoryItem(text, targetLi) {
  if (historyEmptyEl) historyEmptyEl.remove();
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-item";
  btn.textContent = text;
  btn.title = text;
  btn.addEventListener("click", () => {
    closeSidebar();
    targetLi.scrollIntoView({ behavior: "smooth", block: "center" });
    targetLi.classList.add("flash");
    setTimeout(() => targetLi.classList.remove("flash"), 1600);
  });
  li.appendChild(btn);
  historyListEl.appendChild(li);
}

historySearchEl.addEventListener("input", () => {
  const q = historySearchEl.value.trim();
  historyListEl.querySelectorAll(".history-item").forEach((btn) => {
    btn.parentElement.hidden = q !== "" && !btn.textContent.includes(q);
  });
});

/* ---- 新しい会話（表示を初期状態に戻す。実行中ジョブのキャラ連動は切る） ---- */
const GREETING =
  "こんにちは、Cube Bot だよ。調べてほしいこと、作ってほしいもの、PC でやってほしいことを、そのまま書いて送ってね。モデルの起動が要る時は、最初の返事まで数分かかることがあるよ。";
document.getElementById("new-chat").addEventListener("click", () => {
  charSeq += 1;
  setCharState("idle", "待機中");
  listEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "msg-ai";
  const bubble = document.createElement("div");
  bubble.className = "bubble-ai";
  const answer = document.createElement("div");
  answer.className = "answer";
  answer.textContent = GREETING;
  bubble.appendChild(answer);
  li.appendChild(bubble);
  listEl.appendChild(li);
  historyListEl.innerHTML = "";
  const empty = document.createElement("li");
  empty.className = "history-empty";
  empty.id = "history-empty";
  empty.textContent = "まだ依頼がない";
  historyListEl.appendChild(empty);
  closeSidebar();
  inputEl.focus();
  scrollDown();
});

/* ---- メッセージ表示 ---- */
function addUserMessage(text) {
  const li = document.createElement("li");
  li.className = "msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const p = document.createElement("p");
  p.textContent = text;
  bubble.appendChild(p);
  li.appendChild(bubble);
  listEl.appendChild(li);
  addHistoryItem(text, li);
  scrollDown();
  return li;
}

function addBotMessage() {
  const li = document.createElement("li");
  li.className = "msg-ai";
  const bubble = document.createElement("div");
  bubble.className = "bubble-ai";
  const answer = document.createElement("div");
  answer.className = "answer";
  answer.textContent = "受け付けたよ。処理中…";
  const progress = document.createElement("div");
  progress.className = "progress";
  bubble.appendChild(answer);
  bubble.appendChild(progress);
  li.appendChild(bubble);
  listEl.appendChild(li);
  scrollDown();
  return { li, bubble, answer, progress };
}

function renderProgress(view, lines) {
  view.progress.innerHTML = "";
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = "・" + line.msg;
    view.progress.appendChild(div);
  }
  scrollDown();
}

function renderOutcome(view, outcome) {
  view.answer.textContent = outcome.message || "（文面が返らなかった）";
  view.progress.innerHTML = "";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "内部の記録（種別・検証）";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(outcome, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  view.bubble.appendChild(details);
  scrollDown();
}

function renderConfirm(view, jobId, outcome, seq) {
  view.answer.textContent = outcome.message || "確認が必要だよ。";
  view.progress.innerHTML = "";
  const box = document.createElement("div");
  box.className = "confirm-box";
  const q = document.createElement("span");
  q.className = "q";
  q.textContent = "実行していい？";
  const yes = document.createElement("button");
  yes.className = "btn btn-primary";
  yes.textContent = "実行する";
  const no = document.createElement("button");
  no.className = "btn";
  no.textContent = "やめる";
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    no.disabled = true;
    box.remove();
    view.answer.textContent = "確認をもらったので実行するね。処理中…";
    setCharState("thinking", "考え中", seq);
    try {
      const r = await fetch(`${BOT_BASE_URL}/task/${jobId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error("confirm failed: " + r.status);
      pollJob(jobId, view, seq);
    } catch (e) {
      view.answer.textContent = "ごめん、確認の送信でエラーになった。サーバーに届かなかったみたい。";
      setCharState("error", "エラー", seq);
    }
  });
  no.addEventListener("click", () => {
    yes.disabled = true;
    no.disabled = true;
    box.remove();
    view.answer.textContent = "分かった、やめておくね。実行はしていないよ。";
    setCharState("done", "中止したよ", seq);
  });
  box.appendChild(q);
  box.appendChild(yes);
  box.appendChild(no);
  view.bubble.appendChild(box);
  scrollDown();
}

async function pollJob(jobId, view, seq) {
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000));
    let data;
    try {
      const r = await fetch(`${BOT_BASE_URL}/task/${jobId}`);
      if (!r.ok) throw new Error("poll failed: " + r.status);
      data = await r.json();
    } catch (e) {
      view.progress.textContent = "状態の取得に失敗した。サーバーが落ちたかも。";
      setCharState("error", "エラー", seq);
      return;
    }
    if (data.state === "queued" || data.state === "running") {
      renderProgress(view, data.progress || []);
      if ((data.progress || []).length > 0) {
        setCharState("working", "作業中", seq);
      } else {
        setCharState("thinking", "考え中", seq);
      }
      continue;
    }
    if (data.state === "needs_confirm" && data.outcome) {
      setCharState("confirm", "確認待ち", seq);
      renderConfirm(view, jobId, data.outcome, seq);
      return;
    }
    if (data.outcome) {
      const failed =
        data.outcome.ok === false ||
        data.outcome.status === "error" ||
        data.outcome.kind === "error";
      setCharState(failed ? "error" : "done", failed ? "エラー" : "完了", seq);
      renderOutcome(view, data.outcome);
      return;
    }
    view.answer.textContent = "状態が分からなかった。";
    setCharState("error", "エラー", seq);
    return;
  }
}

async function sendTask() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  autoGrowInput();
  plusPanel.hidden = true;
  plusBtn.setAttribute("aria-expanded", "false");
  sendEl.disabled = true;
  charSeq += 1;
  const seq = charSeq;
  setCharState("thinking", "考え中", seq);
  addUserMessage(text);
  const view = addBotMessage();
  try {
    const r = await fetch(`${BOT_BASE_URL}/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error("post failed: " + r.status);
    const data = await r.json();
    pollJob(data.job_id, view, seq);
  } catch (e) {
    view.answer.textContent = "ごめん、サーバーに届かなかった。iMac が起きているか、接続を確認してね。";
    view.progress.innerHTML = "";
    setCharState("error", "エラー", seq);
  } finally {
    sendEl.disabled = false;
  }
}

sendEl.addEventListener("click", sendTask);
inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    sendTask();
  }
});

/* 入力欄の自動伸縮と提案チップ。どちらも見た目・入力補助だけで、
   送信やポーリングの経路は変えない。 */
function autoGrowInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 168) + "px";
}
inputEl.addEventListener("input", autoGrowInput);
sendEl.addEventListener("click", () => setTimeout(autoGrowInput, 0));

/* ＋ボタン：依頼の例パネルの開閉。 */
plusBtn.addEventListener("click", () => {
  const open = plusPanel.hidden;
  plusPanel.hidden = !open;
  plusBtn.setAttribute("aria-expanded", String(open));
});
document.querySelectorAll(".suggest-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.q || chip.textContent;
    autoGrowInput();
    plusPanel.hidden = true;
    plusBtn.setAttribute("aria-expanded", "false");
    inputEl.focus();
  });
});

(async () => {
  try {
    const r = await fetch(`${BOT_BASE_URL}/health`);
    const data = await r.json();
    if (data.status === "ok") {
      connDot.className = "dot dot-ok";
      connText.textContent = "Bot サーバーに接続できている";
    } else {
      throw new Error("not ok");
    }
  } catch (e) {
    connDot.className = "dot dot-ng";
    connText.textContent = "Bot サーバーに届かない";
  }
})();
