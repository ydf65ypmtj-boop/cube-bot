"use strict";
/*
 * Cube Bot 通話モード（試作、2026-11-25）。
 *
 * Meta の Muse エージェント「Agrippa」のデモがきっかけ：名前のある
 * 相棒に音声で話しかけると、予定を把握して挨拶し、用事を引き受ける。
 * 実電話回線は使わず、Bot ページ上の Web 音声通話として実装する。
 *
 * 構成（新しいモデルは作らない。既存部品の配線だけ）：
 * - 音声ループは Cube 本体で実績のある cube_voice.js をそのまま使う
 *   （Web Speech API の音声認識 ja-JP → 返答 → VOICEVOX 読み上げ
 *   ＋ /voice/schedule の母音タイミングで口パク）。声はサーバー側の
 *   既定＝VOICEVOX Nemo 男声3（speaker 10002）。
 * - 挨拶は Bot サーバー GET /call/greeting（実データだけで組み立て
 *   られた文）を受けて読み上げる。材料が取れなければ予定には触れない。
 * - 発話の振り分けはこのファイルの classifyUtterance：
 *   雑談（挨拶・感想・意見・軽い会話）だけ → POST /call/chat
 *   （Cube Speak へ中継）。Speak は知識に無いことを捏造する弱点が
 *   あるため、事実の質問（事実確認・ニュース・数値など）と用事は
 *   検証ゲートを通るジョブ経路 POST /task へ回す。判定に迷う場合は
 *   事実系として扱う（安全側）。
 * - 確認ゲートは画面ボタンと音声（はい／やめて）の両方で受ける。
 *   実行結果は outcome.message をそのまま読み上げ、未検証のことを
 *   「できた」とは言わない（ペルソナ準拠）。
 *
 * 純粋関数（classifyUtterance / isConfirmYes / isConfirmNo /
 * findSupabaseJwt / isEndPhrase）は Node でも読み込んでテストできる。
 */
(function (global) {

  const BOT_BASE_URL = "https://imac.tail9ed76a.ts.net:8444";
  const VOICE_BASE_URL = "https://imac.tail9ed76a.ts.net:8443";

  /* ---------------------------------------------------------------- */
  /* 純粋関数                                                          */
  /* ---------------------------------------------------------------- */

  /* 振り分け方針（2026-11-25 本人指摘で確定）：
     Cube Speak の既知の弱点は「知識ベースに無いことを捏造する」
     こと。そのため Speak の自由生成で答えてよいのは雑談
     （挨拶・感想・意見・軽い会話）だけに限る。事実に関する質問
     （人物・予定以外の事実確認、ニュース、数値など）と用事は、
     検証ゲートを通る Bot の既存経路（/task）へ回す。
     判定に迷う場合は事実系として扱う（安全側）。 */
  const TASK_MARKERS = [
    "調べて", "調べもの", "検索して", "教えて", "作って", "作成して",
    "消して", "削除して", "送って", "送信して", "開いて", "操作して",
    "要約して", "翻訳して", "計算して", "まとめて", "書いて",
    "予約して", "予定を入れ", "予定を教え", "予定は", "メールを",
    "天気", "ニュース", "探して", "買って", "注文して",
    "とは", "誰", "いつ", "どこ", "何時", "いくら", "なぜ", "どうして",
    "お願い",
  ];
  /* 疑問詞：これらで聞く文は原則「事実を尋ねている」側に倒す。 */
  const QUESTION_WORDS = ["何", "なに", "どんな", "どれ", "どちら", "いくつ"];
  /* 短い質問形でも雑談とみなしてよい目印（様子伺い・相づち系）。 */
  const CASUAL_HINTS = [
    "元気", "調子", "疲れ", "つかれ", "眠", "ねむ", "暇", "ひま",
    "好き", "嫌い", "聞こえ", "大丈夫", "いる",
  ];
  /* 質問形の語尾（確認・問いかけ）。事実確認はここで事実側に倒す。 */
  const QUESTION_TAIL = /(か|の|かな|だよね|でしょ|じゃない|？|\?)\s*[？?。]*\s*$/;

  function classifyUtterance(text) {
    const t = String(text || "").trim();
    if (!t) return "chat";
    // 用事・既知の事実マーカー
    for (const m of TASK_MARKERS) {
      if (t.includes(m)) return "task";
    }
    // 数値を含む発話は事実側（数値の捏造を Speak にさせない）
    if (/[0-9０-９]/.test(t)) return "task";
    // 疑問詞で聞いている文は事実側
    for (const w of QUESTION_WORDS) {
      if (t.includes(w)) return "task";
    }
    // 質問形：短い様子伺いだけ雑談、それ以外は事実側（安全側）
    if (QUESTION_TAIL.test(t)) {
      const casual = t.length <= 14 &&
        CASUAL_HINTS.some((h) => t.includes(h));
      return casual ? "chat" : "task";
    }
    // 残り（挨拶・感想・意見・気持ちの表明）は雑談
    return "chat";
  }

  /* 確認ゲートの音声応答。短い相づちだけを拾い、長文は判定しない
     （用事の続きと誤認しないため）。 */
  function isConfirmYes(text) {
    const t = String(text || "").replace(/[\s。、！？!?,.]/g, "");
    return ["はい", "うん", "いいよ", "いいです", "実行して", "お願い",
            "おねがい", "オッケー", "OK", "ok"].includes(t);
  }
  function isConfirmNo(text) {
    const t = String(text || "").replace(/[\s。、！？!?,.]/g, "");
    return ["やめて", "やめる", "いいえ", "ダメ", "だめ", "キャンセル",
            "やっぱりやめて", "止めて", "とめて"].includes(t);
  }

  /* 通話を終える言い方。 */
  function isEndPhrase(text) {
    const t = String(text || "").replace(/[\s。、！？!?,.]/g, "");
    return ["バイバイ", "もういいよ", "終わり", "おわり", "切って",
            "きって", "じゃあね", "またね"].includes(t);
  }

  /* Cube ページと同じ Supabase セッション（同一オリジンの
     localStorage）があれば access_token を取り出す。連携済み
     ユーザーの Google カレンダーを引くためのもので、取れなければ
     null（挨拶はカレンダー無しで組み立てられる）。 */
  function findSupabaseJwt(storage) {
    try {
      if (!storage) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key || !/^sb-[a-z0-9]+-auth-token$/.test(key)) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const token = parsed && parsed.access_token;
        const exp = parsed && parsed.expires_at;
        if (typeof token === "string" && token &&
            (typeof exp !== "number" || exp > nowSec)) {
          return token;
        }
      }
    } catch { /* 取れなければカレンダー無しで続ける */ }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* ホストアダプタ（CubeVoice セッションとの橋渡し）                  */
  /* ---------------------------------------------------------------- */

  /* deps: { fetchFn, botBaseUrl, onTranscript(role, text),
           onConfirmChange(pending), onBusyChange(busy), onProgress(lines) }
     session への返答は emit(text) で届ける。 */
  function createCallHost(deps) {
    const d = deps || {};
    const fetchFn = d.fetchFn;
    const base = String(d.botBaseUrl || BOT_BASE_URL).replace(/\/+$/, "");
    const say = (role, text) => { if (d.onTranscript) d.onTranscript(role, text); };

    const host = {
      _cb: null,
      chatHistory: [],       // Speak 用の会話履歴 {role, content}
      pendingConfirm: null,  // {jobId}
      busy: false,
      pendingEnd: false,

      onAssistant(cb) {
        host._cb = cb;
        return () => { if (host._cb === cb) host._cb = null; };
      },
      isBusy() { return host.busy; },

      emit(text) {
        const t = String(text || "").trim();
        if (!t) return;
        say("bot", t);
        if (host._cb) host._cb({ text: t });
      },

      _setBusy(v) {
        host.busy = v;
        if (d.onBusyChange) d.onBusyChange(v);
      },
      _setConfirm(jobId) {
        host.pendingConfirm = jobId ? { jobId } : null;
        if (d.onConfirmChange) d.onConfirmChange(host.pendingConfirm);
      },

      /* ---- 挨拶 ---- */
      async greet(jwt) {
        const headers = {};
        if (jwt) headers.Authorization = "Bearer " + jwt;
        try {
          const r = await fetchFn(base + "/call/greeting", { headers });
          if (!r.ok) throw new Error("greeting http " + r.status);
          const data = await r.json();
          if (data && data.greeting) {
            host.emit(data.greeting);
            return data;
          }
          throw new Error("greeting empty");
        } catch {
          // 材料が取れなかった時用の定型挨拶。予定・天気には触れない。
          host.emit("こんにちは、Cube Botだよ。何か用事があったら言ってね。");
          return null;
        }
      },

      /* ---- 確認への応答（音声・ボタン共通） ---- */
      async answerConfirm(yes) {
        const pending = host.pendingConfirm;
        if (!pending) return;
        host._setConfirm(null);
        if (!yes) {
          host.emit("分かった、やめておくね。実行はしていないよ。");
          return;
        }
        host.emit("確認をもらったので実行するね。");
        host._setBusy(true);
        try {
          const r = await fetchFn(`${base}/task/${pending.jobId}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!r.ok) throw new Error("confirm http " + r.status);
          await host._pollJob(pending.jobId);
        } catch {
          host.emit("ごめん、確認の送信でエラーになった。サーバーに届かなかったみたい。");
        } finally {
          host._setBusy(false);
        }
      },

      /* ---- ジョブのポーリング ---- */
      async _pollJob(jobId) {
        for (;;) {
          await new Promise((res) => setTimeout(res, 3000));
          let data;
          try {
            const r = await fetchFn(`${base}/task/${jobId}`);
            if (!r.ok) throw new Error("poll http " + r.status);
            data = await r.json();
          } catch {
            host.emit("ごめん、状態の取得に失敗した。サーバーが落ちたかも。");
            return;
          }
          if (data.state === "queued" || data.state === "running") {
            if (d.onProgress) d.onProgress(data.progress || []);
            continue;
          }
          if (data.state === "needs_confirm" && data.outcome) {
            host._setConfirm(jobId);
            host.emit(data.outcome.message || "確認が必要だよ。実行していい？");
            return;
          }
          if (data.outcome) {
            host.emit(data.outcome.message || "終わったよ。");
            return;
          }
          host.emit("状態が分からなかった。ごめん。");
          return;
        }
      },

      /* ---- 発話の入口（session から呼ばれる） ---- */
      ask(text) {
        const q = String(text || "").trim();
        if (!q) return false;

        // 確認待ちの間は、はい／やめて だけを受け付ける。
        if (host.pendingConfirm) {
          if (isConfirmNo(q)) { void host.answerConfirm(false); return true; }
          if (isConfirmYes(q)) { void host.answerConfirm(true); return true; }
          host.emit("ごめん、確認の途中だよ。実行するなら「はい」、やめるなら「やめて」って言ってね。");
          return true;
        }

        if (isEndPhrase(q)) {
          host.pendingEnd = true;
          host.emit("分かった、切るね。また話そう。");
          return true;
        }

        if (host.busy) {
          host.emit("今、前の用事をやってる途中だよ。終わるまで待ってね。");
          return true;
        }

        if (classifyUtterance(q) === "chat") {
          void host._doChat(q);
        } else {
          void host._doTask(q);
        }
        return true;
      },

      async _doChat(q) {
        host._setBusy(true);
        host.chatHistory.push({ role: "user", content: q });
        host.chatHistory = host.chatHistory.slice(-12);
        try {
          const r = await fetchFn(base + "/call/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: host.chatHistory }),
          });
          if (!r.ok) throw new Error("chat http " + r.status);
          const data = await r.json();
          const text = (data && data.text || "").trim();
          if (!text) throw new Error("chat empty");
          host.chatHistory.push({ role: "assistant", content: text });
          host.emit(text);
        } catch {
          host.emit("ごめん、今は雑談の担当につながらなかった。もう一度言ってみて。");
        } finally {
          host._setBusy(false);
        }
      },

      async _doTask(q) {
        host._setBusy(true);
        try {
          const r = await fetchFn(base + "/task", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: q }),
          });
          if (!r.ok) throw new Error("task http " + r.status);
          const data = await r.json();
          await host._pollJob(data.job_id);
        } catch {
          host.emit("ごめん、サーバーに届かなかった。iMac が起きているか確認してね。");
        } finally {
          host._setBusy(false);
        }
      },
    };
    return host;
  }

  /* ---------------------------------------------------------------- */
  /* ブラウザ UI                                                       */
  /* ---------------------------------------------------------------- */

  const STATUS_LABELS = {
    idle: "「電話をかける」を押してね",
    connecting: "接続中…",
    listening: "聞き取り中（話してね）",
    thinking: "考え中…",
    working: "作業中…",
    speaking: "話し中",
    confirm: "確認待ち",
    error: "エラーがありました",
    ended: "通話は終わったよ",
  };

  function mountCallMode(env) {
    const e = env || {};
    const doc = e.document || (typeof document !== "undefined" ? document : null);
    const win = e.window || (typeof window !== "undefined" ? window : null);
    const CubeVoice = e.CubeVoice || global.CubeVoice;
    if (!doc || !win || !CubeVoice) return null;
    const overlay = doc.getElementById("call-overlay");
    const openBtn = doc.getElementById("call-open");
    if (!overlay || !openBtn) return null;

    const $ = (id) => doc.getElementById(id);
    const charEl = $("call-char");
    const statusEl = $("call-status");
    const subtitleEl = $("call-subtitle");
    const transcriptEl = $("call-transcript");
    const mainBtn = $("call-main-btn");
    const talkBtn = $("call-talk-btn");
    const closeBtn = $("call-close");
    const automicBox = $("call-automic");
    const engineEl = $("call-engine");
    const confirmBox = $("call-confirm");
    const confirmYes = $("call-confirm-yes");
    const confirmNo = $("call-confirm-no");
    const textForm = $("call-textform");
    const textInput = $("call-textinput");

    /* ---- キャラ（口パク用フレームを重ねる） ---- */
    const frames = win.CubeBotCharFrames || {};
    const charImgs = {};
    charEl.querySelectorAll("img[data-frame]").forEach((img) => {
      charImgs[img.dataset.frame] = img;
      const src = frames[img.dataset.frame];
      if (src) {
        img.src = src;
        img.hidden = false;
      }
    });
    const charFallback = charEl.querySelector(".call-char-fallback");
    if (frames.base && charFallback) charFallback.hidden = true;

    const lipSync = CubeVoice.createLipSync({
      show(key) {
        const target = charImgs[key] ? key : "base";
        for (const k of Object.keys(charImgs)) {
          charImgs[k].classList.toggle("on", k === target);
        }
      },
      requestAnimationFrame: win.requestAnimationFrame
        ? win.requestAnimationFrame.bind(win) : null,
      cancelAnimationFrame: win.cancelAnimationFrame
        ? win.cancelAnimationFrame.bind(win) : null,
    });
    const lipSyncProxy = {
      play(schedule, clock) { lipSync.play(schedule, clock); },
      stopPlayback() { lipSync.stopPlayback(); },
    };

    /* ---- 文字起こし ---- */
    function addTranscript(role, text) {
      const div = doc.createElement("div");
      div.className = "call-line call-line-" + role;
      const who = doc.createElement("span");
      who.className = "call-who";
      who.textContent = role === "user" ? "あなた" : role === "bot" ? "Cube Bot" : "";
      const body = doc.createElement("span");
      body.textContent = text;
      if (who.textContent) div.appendChild(who);
      div.appendChild(body);
      transcriptEl.appendChild(div);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    /* ---- 音声まわり ---- */
    let sharedAudioEl = null;
    try { sharedAudioEl = new win.Audio(); } catch { sharedAudioEl = null; }
    const browserEngine = CubeVoice.createBrowserTtsEngine({
      speechSynthesis: win.speechSynthesis,
      SpeechSynthesisUtterance: win.SpeechSynthesisUtterance,
      lang: "ja-JP",
    });
    let voicevoxEngine = null;
    function makeVoicevox() {
      voicevoxEngine = CubeVoice.createVoicevoxEngine({
        fetch: win.fetch.bind(win),
        URL: win.URL,
        Audio: win.Audio,
        audioElement: sharedAudioEl,
        serverBaseUrl: VOICE_BASE_URL,
        speaker: null, // サーバー側の既定 = VOICEVOX Nemo 男声3 (10002)
        lipSync: lipSyncProxy,
      });
      return voicevoxEngine;
    }
    const queue = CubeVoice.createSpeechQueue({ engine: browserEngine });
    const recognizer = CubeVoice.createWebSpeechRecognizer({
      SpeechRecognition: win.SpeechRecognition,
      webkitSpeechRecognition: win.webkitSpeechRecognition,
      lang: "ja-JP",
    });

    let uiState = "idle";       // idle | connecting | session states | working | confirm
    let inCall = false;

    const host = createCallHost({
      fetchFn: win.fetch.bind(win),
      botBaseUrl: BOT_BASE_URL,
      onTranscript: (role, text) => {
        addTranscript(role, text);
        mirrorToChat(role, text);
      },
      onConfirmChange: (pending) => {
        confirmBox.hidden = !pending;
        if (pending) setUiState("confirm");
        else if (inCall) setUiState(session.state);
      },
      onBusyChange: (busy) => {
        if (!inCall) return;
        if (busy && !host.pendingConfirm) setUiState("working");
        else if (!busy && !host.pendingConfirm) setUiState(session.state);
      },
      onProgress: (lines) => {
        if (lines && lines.length) {
          subtitleEl.textContent = lines[lines.length - 1].msg || "";
        }
      },
    });

    const ua = (win.navigator && win.navigator.userAgent) || "";
    const session = CubeVoice.createSession({
      host, recognizer, queue,
      autoMic: true,
      bargeIn: !CubeVoice._internal.isIosLike(ua),
      fallbackEngine: browserEngine,
      thinkingTimeoutMs: 600000, // Bot のジョブはモデルの起動で数分かかる
    });

    function setUiState(state) {
      uiState = state;
      statusEl.textContent = STATUS_LABELS[state] || state;
      overlay.dataset.state = state;
    }

    session.on("state", (s) => {
      if (!inCall) return;
      if (host.pendingConfirm) { setUiState("confirm"); return; }
      if (host.busy) { setUiState("working"); return; }
      setUiState(s);
      if (s === "listening" && host.pendingEnd) {
        host.pendingEnd = false;
        setTimeout(finishCall, 600);
      }
    });
    session.on("user", (text) => {
      addTranscript("user", text);
      mirrorToChat("user", text);
      subtitleEl.textContent = "";
    });
    session.on("subtitle", (sentence) => { subtitleEl.textContent = sentence; });
    session.on("notice", (msg) => { addTranscript("note", msg); });
    session.on("engine", (kind) => {
      engineEl.textContent = kind === "voicevox" ? "声：VOICEVOX Nemo" : "声：ブラウザ内蔵";
    });

    /* メインのチャット欄へも写す（通話を閉じても会話が残るように）。
       script.js の表示関数が無い環境では何もしない。 */
    function mirrorToChat(role, text) {
      try {
        if (role === "user" && typeof global.addUserMessage === "function") {
          global.addUserMessage(text);
        } else if (role === "bot" && typeof global.addBotMessage === "function") {
          const view = global.addBotMessage();
          view.answer.textContent = text;
          if (view.progress) view.progress.remove();
        }
      } catch { /* 写しは補助。失敗しても通話は続ける */ }
    }

    /* ---- 通話の開始・終了 ---- */
    async function startCall() {
      if (inCall) return;
      inCall = true;
      mainBtn.textContent = "切る";
      closeBtn.hidden = true;
      setUiState("connecting");
      transcriptEl.innerHTML = "";
      subtitleEl.textContent = "";
      if (voicevoxEngine && voicevoxEngine.unlock) voicevoxEngine.unlock();
      session.start();
      lipSync.start();
      talkBtn.hidden = automicBox.checked;
      // 声の本線（VOICEVOX）が使えるか確認し、使えれば差し替える。
      CubeVoice.probeVoicevox({
        fetch: win.fetch.bind(win),
        serverBaseUrl: VOICE_BASE_URL,
      }).then((ok) => {
        if (ok) {
          session.setEngine(makeVoicevox());
          if (voicevoxEngine.unlock) voicevoxEngine.unlock();
        }
        engineEl.textContent = ok ? "声：VOICEVOX Nemo" : "声：ブラウザ内蔵";
      }).catch(() => {});
      const jwt = findSupabaseJwt(win.localStorage || null);
      await host.greet(jwt);
    }

    function finishCall() {
      if (!inCall) return;
      inCall = false;
      host.pendingEnd = false;
      host._setConfirm(null);
      confirmBox.hidden = true;
      session.end();
      lipSync.stop();
      talkBtn.hidden = true;
      mainBtn.textContent = "電話をかける";
      closeBtn.hidden = false;
      setUiState("ended");
    }

    mainBtn.addEventListener("click", () => {
      if (inCall) finishCall();
      else void startCall();
    });
    talkBtn.addEventListener("click", () => { session.startListening(); });
    automicBox.addEventListener("change", () => {
      session.setAutoMic(automicBox.checked);
      talkBtn.hidden = automicBox.checked || !inCall;
    });
    confirmYes.addEventListener("click", () => { void host.answerConfirm(true); });
    confirmNo.addEventListener("click", () => { void host.answerConfirm(false); });

    if (!recognizer.available) {
      textForm.hidden = false;
      addTranscript("note", "このブラウザでは音声認識が使えないので、文字で話してね。");
    }
    textForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = textInput.value.trim();
      if (!text) return;
      textInput.value = "";
      if (!inCall) {
        // 通話を始めていない文字送信は、挨拶なしで会話だけ始める。
        inCall = true;
        mainBtn.textContent = "切る";
        closeBtn.hidden = true;
        session.start();
        lipSync.start();
      }
      session.submitUtterance(text);
    });

    openBtn.addEventListener("click", () => {
      overlay.hidden = false;
      if (typeof global.closeSidebar === "function") global.closeSidebar();
    });
    closeBtn.addEventListener("click", () => {
      if (inCall) finishCall();
      overlay.hidden = true;
      setUiState("idle");
      mainBtn.textContent = "電話をかける";
    });

    engineEl.textContent = "声：ブラウザ内蔵";
    setUiState("idle");
    return { session, host, startCall, finishCall };
  }

  const api = {
    classifyUtterance, isConfirmYes, isConfirmNo, isEndPhrase,
    findSupabaseJwt, createCallHost, mountCallMode,
    BOT_BASE_URL, VOICE_BASE_URL,
  };
  global.CubeBotCall = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => mountCallMode());
    } else {
      mountCallMode();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
