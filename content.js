// Content script: detects a double-clicked word and shows a popup next to it.
// The popup lives in a closed Shadow DOM so site CSS can't break it.
// All API text is inserted with textContent (never innerHTML).

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const WORD_RE = /^[A-Za-z][A-Za-z'-]{0,44}$/;

  let host = null;
  let card = null;
  let anchor = null; // selected word's box, in page coordinates
  let token = 0;     // ignores replies from outdated lookups

  const CSS = `
    :host { all: initial; }
    .card {
      --bg: #ffffff; --ink: #1d2340; --muted: #5b6178; --line: #dde1ec;
      --accent: #0e7c86; --tint: #e6f3f4;
      position: absolute; box-sizing: border-box;
      width: min(340px, calc(100vw - 16px)); max-height: 360px; overflow: auto;
      padding: 14px 16px 16px; text-align: left;
      background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(20, 24, 50, 0.18);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      letter-spacing: normal; text-transform: none;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        --bg: #171a2b; --ink: #eceef6; --muted: #a3a9c2; --line: #2c3150;
        --accent: #5cc8d2; --tint: #1f3a40;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
      }
    }
    @media (prefers-reduced-motion: no-preference) {
      .card { animation: in 0.12s ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(-3px); } }
    }
    .head { display: flex; align-items: center; gap: 8px; padding-right: 24px; }
    .word { margin: 0; font: 600 22px/1.2 Georgia, "Iowan Old Style", Charter, serif; }
    .phon { margin-top: 2px; color: var(--muted); font-size: 13px; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer; color: var(--accent);
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
    }
    button:hover { background: var(--tint); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .speak { width: 28px; height: 28px; border: 1px solid var(--line); flex: none; }
    .close { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px;
             font-size: 18px; line-height: 1; color: var(--muted); }
    .pos { margin: 12px 0 4px; color: var(--accent); font-style: italic; font-weight: 600; }
    .def { margin: 0 0 6px; }
    .ex { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--accent);
          color: var(--muted); font-style: italic; }
    .msg { margin: 6px 0 0; color: var(--muted); }
    .src { margin-top: 12px; color: var(--muted); font-size: 11px; }
  `;

  const SPEAKER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>
    <path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;

  // ---------- helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cleanWord(raw) {
    const w = raw.trim().replace(/’/g, "'").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    return WORD_RE.test(w) ? w : null;
  }

  function isEditable(target) {
    return !!(target && target.closest &&
      target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
  }

  function playAudio(url, word) {
    const speak = () => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(word);
        u.lang = "en-US";
        speechSynthesis.speak(u);
      } catch { /* nothing else to try */ }
    };
    if (!url) return speak();
    new Audio(url).play().catch(speak); // falls back if the site's CSP blocks audio
  }

  // ---------- popup ----------
  function ensureCard() {
    if (card) return;
    host = document.createElement("div");
    host.style.cssText =
      "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Word meaning");
    shadow.append(style, card);
    document.documentElement.appendChild(host);
  }

  function close() {
    token++;
    if (host) host.remove();
    host = card = null;
  }

  function place() {
    if (!card || !anchor) return;
    const margin = 8;
    const vw = document.documentElement.clientWidth;
    const w = card.offsetWidth;
    const h = card.offsetHeight;

    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(scrollX + margin, Math.min(left, scrollX + vw - w - margin));

    const spaceBelow = innerHeight - (anchor.bottom - scrollY);
    const spaceAbove = anchor.top - scrollY;
    let top = anchor.bottom + margin;
    if (spaceBelow < h + margin && spaceAbove > spaceBelow) top = anchor.top - margin - h;

    card.style.left = left + "px";
    card.style.top = Math.max(scrollY + margin, top) + "px";
  }

  function show(...nodes) {
    ensureCard();
    card.replaceChildren(...nodes);
    place();
  }

  function closeButton() {
    const b = el("button", "close", "×");
    b.setAttribute("aria-label", "Close");
    b.addEventListener("click", close);
    return b;
  }

  function headerFor(word, phonetic, audio) {
    const wrap = el("div");
    const head = el("div", "head");
    head.append(el("h2", "word", word));

    const speak = el("button", "speak");
    speak.setAttribute("aria-label", "Hear pronunciation");
    speak.innerHTML = SPEAKER; // static markup only
    speak.addEventListener("click", () => playAudio(audio, word));
    head.append(speak);

    wrap.append(head);
    if (phonetic) wrap.append(el("div", "phon", phonetic));
    return wrap;
  }

  function viewLoading(word) {
    show(closeButton(), headerFor(word, "", ""), el("p", "msg", "Looking up…"));
  }

  function viewResult(r) {
    const nodes = [closeButton(), headerFor(r.word, r.phonetic, r.audio)];
    for (const m of r.meanings) {
      nodes.push(el("div", "pos", m.pos));
      for (const d of m.defs) {
        nodes.push(el("p", "def", d.definition));
        if (d.example) nodes.push(el("p", "ex", d.example));
      }
    }
    nodes.push(el("div", "src", "Source: dictionaryapi.dev"));
    show(...nodes);
  }

  function viewMessage(word, text) {
    show(closeButton(), headerFor(word, "", ""), el("p", "msg", text));
  }

  async function lookup(word) {
    const mine = ++token;
    viewLoading(word);

    let res;
    try {
      res = await api.runtime.sendMessage({ type: "LOOKUP", word });
    } catch {
      res = null;
    }
    if (mine !== token || !card) return; // closed or replaced meanwhile

    if (res && res.status === "ok") viewResult(res);
    else if (res && res.status === "not_found")
      viewMessage(word, "No entry found. Try the base form, like “run” instead of “running”.");
    else viewMessage(word, "Couldn’t reach the dictionary. Check your connection and try again.");
  }

  // ---------- triggers ----------
  document.addEventListener("dblclick", (e) => {
    if (isEditable(e.target)) return;
    if (host && e.composedPath().includes(host)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const word = cleanWord(sel.toString());
    if (!word) return;

    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return;
    anchor = {
      left: r.left + scrollX, top: r.top + scrollY,
      bottom: r.bottom + scrollY, width: r.width,
    };
    lookup(word);
  });

  // Click anywhere outside the popup closes it.
  document.addEventListener("mousedown", (e) => {
    if (host && !e.composedPath().includes(host)) close();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && host) close();
  });
})();
