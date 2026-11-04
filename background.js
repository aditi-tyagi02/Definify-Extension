const api = globalThis.browser ?? globalThis.chrome;

const ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const MAX_CACHE = 300;     // remembered words
const MAX_MEANINGS = 3;    // parts of speech shown
const MAX_DEFS = 2;        // definitions per part of speech

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "LOOKUP" || typeof msg.word !== "string") return false;
  lookup(msg.word).then(sendResponse, () => sendResponse({ status: "error" }));
  return true; // keep the channel open for the async reply
});

async function fetchWithRetry(url) {
  // Free APIs hiccup. Try up to 3 times with a short timeout and pause.
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      // 200 and 404 are real answers. 429 and 5xx are worth retrying.
      if (res.ok || res.status === 404) return { res };
      lastError = "HTTP " + res.status;
    } catch (err) {
      clearTimeout(timer);
      lastError = (err && err.name === "AbortError") ? "timeout" : String(err);
    }
    console.warn("[Instant Word Meaning] attempt " + attempt + " failed:", lastError);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  return { error: lastError };
}

async function lookup(raw) {
  const word = raw.trim().toLowerCase().slice(0, 45);
  if (!word) return { status: "not_found", word };

  const stored = await api.storage.local.get("cache");
  const cache = stored.cache || {};
  if (cache[word]) return cache[word].data;

  const { res, error } = await fetchWithRetry(ENDPOINT + encodeURIComponent(word));
  if (error) {
    console.error("[Instant Word Meaning] giving up on \"" + word + "\":", error);
    return { status: "error", reason: error };
  }
  if (res.status === 404) return { status: "not_found", word };

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("[Instant Word Meaning] bad JSON for \"" + word + "\":", err);
    return { status: "error", reason: "bad response" };
  }

  const data = parse(word, json);
  if (!data) return { status: "not_found", word };

  cache[word] = { data, t: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => cache[a].t - cache[b].t)
        .slice(0, keys.length - MAX_CACHE)
        .forEach((k) => delete cache[k]);
  }
  try { await api.storage.local.set({ cache }); } catch (err) {
    console.warn("[Instant Word Meaning] cache save failed:", err);
  }
  return data;
}

function parse(word, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const phonetics = entries.flatMap((e) => e.phonetics || []);
  const phonetic =
    entries.find((e) => e.phonetic)?.phonetic ||
    phonetics.find((p) => p.text)?.text ||
    "";

  let audio = phonetics.find((p) => p.audio)?.audio || "";
  if (audio.startsWith("//")) audio = "https:" + audio;
  if (!audio.startsWith("https://")) audio = "";

  // Merge definitions by part of speech across all entries.
  const byPos = new Map();
  for (const entry of entries) {
    for (const m of entry.meanings || []) {
      const list = byPos.get(m.partOfSpeech) || [];
      for (const d of m.definitions || []) {
        if (d.definition) list.push({ definition: d.definition, example: d.example || "" });
      }
      byPos.set(m.partOfSpeech, list);
    }
  }

  const meanings = [...byPos]
    .filter(([, defs]) => defs.length > 0)
    .slice(0, MAX_MEANINGS)
    .map(([pos, defs]) => ({ pos, defs: defs.slice(0, MAX_DEFS) }));

  if (meanings.length === 0) return null;
  return { status: "ok", word: entries[0].word || word, phonetic, audio, meanings };
}