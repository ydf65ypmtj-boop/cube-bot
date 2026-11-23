"use strict";
/* Cube Bot 入口ページ。
   接続先は iMac の Bot サーバー (8103) を Tailscale Serve (8444、
   tailnet 内のみ) 経由で叩く。Cube の cube-server (8443) と同じ型。
   依頼は POST /task で即 job_id が返り、GET /task/<id> をポーリング
   して進捗と結果を表示する (モデル起動と生成で数分かかるため)。
   確認ゲート: state が needs_confirm になったら確認ボタンを出し、
   承認時のみ POST /task/<id>/confirm を送る。 */
const BOT_BASE_URL = "https://imac.tail9ed76a.ts.net:8444";

const listEl = document.getElementById("msg-list");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const scrollEl = document.getElementById("chat-scroll");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");

function scrollDown() {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

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
  scrollDown();
  return li;
}

function addBotMessage() {
  const li = document.createElement("li");
  li.className = "msg-ai";
  const answer = document.createElement("div");
  answer.className = "answer";
  answer.textContent = "受け付けたよ。処理中…";
  const progress = document.createElement("div");
  progress.className = "progress";
  li.appendChild(answer);
  li.appendChild(progress);
  listEl.appendChild(li);
  scrollDown();
  return { li, answer, progress };
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
  view.li.appendChild(details);
  scrollDown();
}

function renderConfirm(view, jobId, outcome) {
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
    try {
      const r = await fetch(`${BOT_BASE_URL}/task/${jobId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) throw new Error("confirm failed: " + r.status);
      pollJob(jobId, view);
    } catch (e) {
      view.answer.textContent = "ごめん、確認の送信でエラーになった。サーバーに届かなかったみたい。";
    }
  });
  no.addEventListener("click", () => {
    yes.disabled = true;
    no.disabled = true;
    box.remove();
    view.answer.textContent = "分かった、やめておくね。実行はしていないよ。";
  });
  box.appendChild(q);
  box.appendChild(yes);
  box.appendChild(no);
  view.li.appendChild(box);
  scrollDown();
}

async function pollJob(jobId, view) {
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000));
    let data;
    try {
      const r = await fetch(`${BOT_BASE_URL}/task/${jobId}`);
      if (!r.ok) throw new Error("poll failed: " + r.status);
      data = await r.json();
    } catch (e) {
      view.progress.textContent = "状態の取得に失敗した。サーバーが落ちたかも。";
      return;
    }
    if (data.state === "queued" || data.state === "running") {
      renderProgress(view, data.progress || []);
      continue;
    }
    if (data.state === "needs_confirm" && data.outcome) {
      renderConfirm(view, jobId, data.outcome);
      return;
    }
    if (data.outcome) {
      renderOutcome(view, data.outcome);
      return;
    }
    view.answer.textContent = "状態が分からなかった。";
    return;
  }
}

async function sendTask() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendEl.disabled = true;
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
    pollJob(data.job_id, view);
  } catch (e) {
    view.answer.textContent = "ごめん、サーバーに届かなかった。iMac が起きているか、接続を確認してね。";
    view.progress.innerHTML = "";
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
document.querySelectorAll(".suggest-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.q || chip.textContent;
    autoGrowInput();
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
