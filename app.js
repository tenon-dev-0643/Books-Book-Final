"use strict";
/* ============================================================
   Books Book! v2（バグ修正版）
   ============================================================ */

/* ---------- ユーティリティ ---------- */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dateOnly(value) {
  const d = value instanceof Date ? value : new Date(`${value}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function daysUntil(value) {
  if (!value) return null;
  return Math.round((dateOnly(value) - dateOnly(new Date())) / 86400000);
}
/* 実在する日付だけを通す厳密な正規化。"2025" や "2025.12" は弾く */
function normalizeDate(value) {
  if (!value) return "";
  const text = String(value).trim().replace(/\//g, "-");
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return normalizeDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return "";
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/* RSSのpubDate（例: "Fri, 24 May 2024 00:00:00 +0900"）を YYYY-MM-DD に変換 */
function parsePubDate(value) {
  if (!value) return "";
  const direct = normalizeDate(value);
  if (direct) return direct;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : isoDate(d);
}
function uniqueItems(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function debounce(fn, delay) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}
function formatPrice(price) {
  if (!price) return "";
  return price.currency === "JPY" ? `¥${price.amount.toLocaleString("ja-JP")}`
    : `${price.amount.toLocaleString()} ${price.currency}`;
}
function normalizeText(value) {
  return String(value || "").toLowerCase()
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "").replace(/\u3000/g, "");
}
function toHalfWidthNumber(value) {
  return String(value || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
/* 巻数抽出: 「第12巻」「(12)」「 12」の3形式に対応 */
function extractVolume(bookTitle, registeredTitle) {
  const withoutSeries = String(bookTitle || "").replace(String(registeredTitle || ""), "");
  const normalized = toHalfWidthNumber(withoutSeries);
  for (const pattern of [/(?:第|\s|^)(\d{1,3})\s*巻/, /[（(]\s*(\d{1,3})\s*[）)]/, /\s(\d{1,3})$/]) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return "";
}
/* 書名からシリーズ名だけを取り出す（巻数・版表記を除去） */
function guessSeriesName(rawTitle) {
  return String(rawTitle || "")
    .replace(/[（(\[［].*?[）)\]］]/g, "")
    .replace(/第?\d+\s*巻/g, "")
    .replace(/vol\.?\s*\d+/gi, "")
    .replace(/\d+\s*$/, "")
    .replace(/\s+/g, " ").trim();
}
function getIsbn(info) {
  const ids = info.industryIdentifiers || [];
  return ids.find((i) => i.type === "ISBN_13")?.identifier
    || ids.find((i) => i.type === "ISBN_10")?.identifier || "";
}
function getPrice(volume) {
  const p = volume.saleInfo?.retailPrice || volume.saleInfo?.listPrice;
  if (!p || typeof p.amount !== "number") return null;
  return { amount: p.amount, currency: p.currencyCode || "JPY" };
}
function xmlText(node, tagName) {
  return node.getElementsByTagName(tagName)[0]?.textContent?.trim() || "";
}
function isbnFromText(value) {
  const compact = String(value || "").replace(/[-\s]/g, "");
  return compact.match(/97[89]\d{10}/)?.[0] || compact.match(/\d{9}[\dX]/i)?.[0] || "";
}
/* ---------- スコアリング（閾値45未満は候補に出さない） ---------- */
const NEGATIVE_WORDS = /小説|novel|公式ガイド|ガイドブック|ファンブック|画集|完全版|文庫版|新装版/i;
function scoreBookTitle(bookTitle, authors, registeredTitle) {
  let score = 0;
  if (normalizeText(bookTitle).includes(normalizeText(registeredTitle.name))) score += 55;
  if (registeredTitle.author && normalizeText(authors).includes(normalizeText(registeredTitle.author))) score += 25;
  if (extractVolume(bookTitle, registeredTitle.name)) score += 10;
  if (NEGATIVE_WORDS.test(bookTitle)) score -= 30;
  return score;
}
function scoreGoogleVolume(volume, registeredTitle) {
  const info = volume.volumeInfo || {};
  let score = scoreBookTitle(info.title || "", (info.authors || []).join(" "), registeredTitle);
  if (normalizeDate(info.publishedDate)) score += 10;
  if (daysUntil(normalizeDate(info.publishedDate) || "1970-01-01") >= -45) score += 8;
  return score;
}

/* ---------- 状態と保存 ---------- */
const STORAGE_KEY = "manga-release-watch.v1";
const API_KEY_STORAGE_KEY = "manga-release-watch.googleBooksKey";
const DISCORD_WEBHOOK_STORAGE_KEY = "manga-release-watch.discordWebhook";
const NOTIFIED_KEY = "manga-release-watch.notified.v1";
const state = {
  titles: [], releases: [], candidates: [],
  googleApiKey: "", discordWebhookUrl: "",
  noticeDays: 3, autoNotify: false,
  search: "", sortOrder: "nextRelease",
  calendarDate: dateOnly(new Date()),
  currentTitleId: null, sheetTitleId: null, syncing: false,
};
/* 修正6: 保存に失敗しても画面の描画は止めない */
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      titles: state.titles, releases: state.releases,
      noticeDays: state.noticeDays, autoNotify: state.autoNotify,
    }));
    localStorage.setItem(API_KEY_STORAGE_KEY, state.googleApiKey || "");
    localStorage.setItem(DISCORD_WEBHOOK_STORAGE_KEY, state.discordWebhookUrl || "");
  } catch (e) {
    console.warn("保存に失敗しました", e);
  }
  /* 認証済みならクラウドにも同期（未ログイン時は auth.js 側で無視される） */
  window.BooksAuth?.queueSave({
    titles: state.titles, releases: state.releases, noticeDays: state.noticeDays,
  });
}
function load(cloudData = null) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.autoNotify = Boolean(parsed.autoNotify);
    if (cloudData && typeof cloudData === "object") {
      /* ログイン時はクラウド側が正 */
      state.titles = Array.isArray(cloudData.titles) ? cloudData.titles : [];
      state.releases = Array.isArray(cloudData.releases) ? cloudData.releases : [];
      state.noticeDays = Number(cloudData.noticeDays) || 3;
    } else {
      state.titles = Array.isArray(parsed.titles) ? parsed.titles : [];
      state.releases = Array.isArray(parsed.releases) ? parsed.releases : [];
      state.noticeDays = parsed.noticeDays ?? 3;
    }
  } catch { state.titles = []; state.releases = []; }
  try {
    state.googleApiKey = localStorage.getItem(API_KEY_STORAGE_KEY) || "";
    state.discordWebhookUrl = localStorage.getItem(DISCORD_WEBHOOK_STORAGE_KEY) || "";
  } catch {}
}

/* ---------- ドメイン参照 ---------- */
const titleFor = (id) => state.titles.find((t) => t.id === id) || null;
const sortedReleases = () => [...state.releases].sort((a, b) => a.date.localeCompare(b.date));
const upcomingReleases = () => sortedReleases().filter((r) => daysUntil(r.date) >= 0);
function nextReleaseDateFor(titleId) {
  return upcomingReleases().find((r) => r.titleId === titleId)?.date || "";
}
function noticeReleases() {
  return upcomingReleases().filter((r) => daysUntil(r.date) <= state.noticeDays);
}
/* 重複登録の防止: 同じ作品・同じ巻・同じ発売日は1件だけ */
function releaseExists(candidate) {
  return state.releases.some((r) => r.titleId === candidate.titleId
    && String(r.volume) === String(candidate.volume) && r.date === candidate.date);
}
function daysLabel(date) {
  const d = daysUntil(date);
  if (d === null) return "";
  return d < 0 ? `${Math.abs(d)}日前に発売` : d === 0 ? "今日発売" : `あと${d}日`;
}
function urgencyClass(date) {
  const d = daysUntil(date);
  return d === 0 ? "urgent" : d <= 7 ? "soon" : "calm";
}
const fmtDate = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" });

/* ============================================================
   外部API
   ============================================================ */
async function fetchOpenBdDate(isbn) {
  if (!isbn) return "";
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
    if (!res.ok) return "";
    const [item] = await res.json();
    const onixDate = item?.onix?.PublishingDetail?.PublishingDate?.[0]?.Date
      || item?.onix?.PublishingDetail?.PublishingDate?.Date;
    return normalizeDate(item?.summary?.pubdate)
      || normalizeDate(item?.hanmoto?.dateshuppan) || normalizeDate(onixDate);
  } catch { return ""; }
}
function usableGoogleKey() {
  const k = (state.googleApiKey || "").trim();
  return /^[A-Za-z0-9_-]{20,}$/.test(k) ? k : "";
}
/* ---------- 表紙画像の自動取得 ---------- */
const coverAttempts = new Set();
const COVER_RETRY_MS = 24 * 3600 * 1000;
/* 修正: 表紙取得の Google Books アクセスを0.8秒間隔に絞る（429対策） */
let coverNextSlot = 0;
async function coverThrottle() {
  const now = Date.now();
  const slot = Math.max(now, coverNextSlot);
  coverNextSlot = slot + 800;
  if (slot > now) await sleep(slot - now);
}
async function fetchOpenBdCover(isbn) {
  if (!isbn) return "";
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
    if (!res.ok) return "";
    const [item] = await res.json();
    return item?.summary?.cover || "";
  } catch { return ""; }
}
async function fetchGoogleCover(registeredTitle, volume) {
  const query = [`intitle:${registeredTitle.name}`];
  if (registeredTitle.author) query.push(`inauthor:${registeredTitle.author}`);
  const params = new URLSearchParams({ q: query.join(" "), printType: "books",
    langRestrict: "ja", maxResults: "20", country: "JP" });
  const gk = usableGoogleKey(); if (gk) params.set("key", gk);
  await coverThrottle();
  let res;
  try { res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json();
  let earliest = null, fallback = "";
  for (const item of (Array.isArray(data.items) ? data.items : [])) {
    const info = item.volumeInfo || {};
    const url = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
    if (!url) continue;
    if (!fallback) fallback = url;
    const volText = extractVolume(info.title || "", registeredTitle.name);
    const volNum = volText ? Number(volText) : null;
    if (volume && volText === String(volume)) return url.replace(/^http:/, "https:");
    if (volNum && (!earliest || volNum < earliest.volNum)) earliest = { volNum, url };
  }
  const chosen = earliest?.url || fallback;
  return chosen ? chosen.replace(/^http:/, "https:") : "";
}
function coverDue(checkedAt) { return !checkedAt || Date.now() - checkedAt > COVER_RETRY_MS; }
async function ensureTitleCover(title) {
  if (
    !title ||
    title.thumbnailUrl ||
    coverAttempts.has("t:" + title.id) ||
    !coverDue(title.thumbnailCheckedAt)
  ) {
    return;
  }

  const key = "t:" + title.id;
  coverAttempts.add(key);

  let url = "";
  try {
    const withIsbn = state.releases.find(
      (r) => r.titleId === title.id && r.isbn
    );

    if (withIsbn) {
      url = await fetchOpenBdCover(withIsbn.isbn);
    }

    if (!url) {
      url = await fetchGoogleCover(title, "");
    }

    if (url) {
      title.thumbnailUrl = url;
      title.thumbnailCheckedAt = Date.now();
      save();
      renderLibrary();
      renderHome();
    } else if (url === "") {
      // 画像が見つからなかった場合の再検索間隔
      title.thumbnailCheckedAt = Date.now();
      save();
    }
  } catch (error) {
    console.error("表紙画像の取得に失敗しました:", error);
  } finally {
    /* 通信・制限エラー（url === null）のときだけ試行中フラグを残し、
       描画のたびに即再リクエストするのを防ぐ。それ以外は次回も試行可。 */
    if (url !== null) coverAttempts.delete(key);
  }
}
/* release の null チェックを先に行う */
async function ensureReleaseCover(release) {
  if (!release || release.thumbnailUrl || coverAttempts.has("r:" + release.id) || !coverDue(release.thumbnailCheckedAt)) return;
  const key = "r:" + release.id;
  const title = titleFor(release.titleId);
  coverAttempts.add(key);
  let url = "";
  try {
    url = await fetchOpenBdCover(release.isbn);
    if (!url && title) url = await fetchGoogleCover(title, release.volume);
    if (url) {
      release.thumbnailUrl = url;
      release.thumbnailCheckedAt = Date.now();
      save(); renderHome(); renderLibrary();
    } else if (url === "") {
      release.thumbnailCheckedAt = Date.now();
      save();
    }
  } catch (error) {
    console.warn("発売予定の表紙画像を取得できませんでした", error);
  } finally {
    if (url !== null) coverAttempts.delete(key);
  }
}

async function searchGoogleCandidates(registeredTitle) {
  const query = [`intitle:${registeredTitle.name}`];
  if (registeredTitle.author) query.push(`inauthor:${registeredTitle.author}`);
  const params = new URLSearchParams({ q: query.join(" "), orderBy: "newest",
    printType: "books", langRestrict: "ja", maxResults: "20", country: "JP" });
  { const gk = usableGoogleKey(); if (gk) params.set("key", gk); }
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);
  if (!res.ok) throw new Error(`Google Books から取得できませんでした (HTTP ${res.status})`);
  const data = await res.json();
  const candidates = [];
  for (const volume of (Array.isArray(data.items) ? data.items : [])) {
    const info = volume.volumeInfo || {};
    const score = scoreGoogleVolume(volume, registeredTitle);
    if (score < 45) continue;
    const isbn = getIsbn(info);
    const openBdDate = await fetchOpenBdDate(isbn);
    const date = openBdDate || normalizeDate(info.publishedDate);
    if (!date || daysUntil(date) < -45) continue;
    const candidate = {
      id: `${registeredTitle.id}:${isbn || volume.id}:${date}`,
      titleId: registeredTitle.id, bookTitle: info.title || registeredTitle.name,
      volume: extractVolume(info.title || "", registeredTitle.name) || "?",
      date, isbn, publisher: info.publisher || "", price: getPrice(volume),
      sourceId: isbn || volume.id,
      sourceLabel: openBdDate ? "Google Books + openBD" : "Google Books",
      thumbnail: info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "",
      score,
    };
    candidate.memo = ["自動取得", isbn ? `ISBN ${isbn}` : "", candidate.publisher].filter(Boolean).join(" / ");
    if (!releaseExists(candidate)) candidates.push(candidate);
  }
  return candidates;
}
/* NDLは同時アクセス制限が厳しい。最低1.5秒あけ、429なら最大2回再試行する */
let ndlLastCall = 0;
async function ndlFetch(params, retries = 2, signal) {
  const waitMs = Math.max(0, 1500 - (Date.now() - ndlLastCall));
  if (waitMs) await sleep(waitMs);
  ndlLastCall = Date.now();
  const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?${params.toString()}`, { signal });
  if (res.status === 429 && retries > 0) {
    await sleep(6000);
    return ndlFetch(params, retries - 1, signal);
  }
  return res;
}
/* 修正3: ISBNは全ての dc:identifier から探す。日付は pubDate や openBD で補う */
async function searchNdlCandidates(registeredTitle) {
  const params = new URLSearchParams({ cnt: "20", title: registeredTitle.name, mediatype: "books" });
  const res = await ndlFetch(params);
  if (!res.ok) throw new Error(res.status === 429
    ? "NDLサーチが混雑しています（429）。少し時間を置いてから再試行してください"
    : `NDLサーチから取得できませんでした (HTTP ${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  const candidates = [];
  const items = [...doc.getElementsByTagName("item")];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const bookTitle = xmlText(item, "title");
    const authors = xmlText(item, "dc:creator") || xmlText(item, "author");
    const publisher = xmlText(item, "dc:publisher");
    const link = xmlText(item, "link");
    /* 先にタイトル・作者だけで見込みのない候補を除外（日付で最大+10点） */
    const baseScore = scoreBookTitle(bookTitle, authors, registeredTitle);
    if (baseScore + 10 < 45) continue;
    const isbn = [...item.getElementsByTagName("dc:identifier")]
      .map((n) => isbnFromText(n.textContent)).find(Boolean) || "";
    let date = normalizeDate(xmlText(item, "dc:date")) || parsePubDate(xmlText(item, "pubDate"));
    if (!date && isbn) date = await fetchOpenBdDate(isbn);
    const score = baseScore + (date ? 10 : 0);
    if (score < 45 || !date || daysUntil(date) < 0) continue;
    const candidate = {
      id: `${registeredTitle.id}:${isbn || `ndl-${link || index}`}:${date}`,
      titleId: registeredTitle.id, bookTitle,
      volume: extractVolume(bookTitle, registeredTitle.name) || "?",
      date, isbn, publisher, price: null,
      sourceId: isbn || link || `ndl-${index}`, sourceLabel: "NDLサーチ",
      thumbnail: "", score,
    };
    candidate.memo = ["自動取得", isbn ? `ISBN ${isbn}` : "", publisher, "NDLサーチ"].filter(Boolean).join(" / ");
    if (!releaseExists(candidate)) candidates.push(candidate);
  }
  return candidates;
}
async function searchTitleCandidates(registeredTitle) {
  const all = [], errors = [];
  let ok = 0;
  try { all.push(...await searchGoogleCandidates(registeredTitle)); ok++; }
  catch (e) { errors.push(e.message); }
  try { all.push(...await searchNdlCandidates(registeredTitle)); ok++; }
  catch (e) { errors.push(e.message); }
  if (!all.length && errors.length && ok === 0) throw new Error(errors.join(" / "));
  return uniqueItems(all, (c) => c.id);
}
/* 修正: 候補の上限は「全体」ではなく「作品ごと」に24件 */
function mergeCandidates(found) {
  const merged = uniqueItems([...state.candidates, ...found], (c) => c.id)
    .sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const perTitle = new Map();
  state.candidates = merged.filter((c) => {
    const n = (perTitle.get(c.titleId) || 0) + 1;
    perTitle.set(c.titleId, n);
    return n <= 24;
  });
}
async function syncCandidatesFor(title) {
  state.syncing = true;
  const status = $("#syncStatus");
  status.textContent = `「${title.name}」の候補を検索しています…`;
  try {
    const found = await searchTitleCandidates(title);
    mergeCandidates(found);
    status.textContent = found.length
      ? `${found.length}件の候補が見つかりました。内容を確認して取り込んでください。`
      : "候補は見つかりませんでした。作品名・作者名を見直すと見つかる場合があります。";
  } catch (e) {
    status.textContent = `${e.message} ネットワークやAPI制限を確認してください。`;
  } finally { state.syncing = false; renderCandidates(); }
}
/* ---------- オートコンプリート ---------- */
const suggestionCache = new Map();
let suggestionCooldownUntil = 0, suggestionIndex = -1, suggestionItems = [];
let suggestSeq = 0, suggestAbort = null;
async function googleSuggestions(query, signal) {
  if (Date.now() < suggestionCooldownUntil) return [];
  const params = new URLSearchParams({ q: `intitle:${query}`, printType: "books",
    langRestrict: "ja", maxResults: "6",
    /* 必要な項目だけ返させて応答を軽くする */
    fields: "items(volumeInfo(title,authors))" });
  { const gk = usableGoogleKey(); if (gk) params.set("key", gk); }
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, { signal });
  if (res.status === 429) { suggestionCooldownUntil = Date.now() + 60000; return []; }
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data.items) ? data.items : []).map((item) => {
    const info = item.volumeInfo || {};
    return { name: guessSeriesName(info.title), author: (info.authors || [])[0] || "" };
  }).filter((s) => s.name);
}
async function ndlSuggestions(query, signal) {
  const params = new URLSearchParams({ cnt: "10", title: query, mediatype: "books" });
  const res = await ndlFetch(params, 1, signal);
  if (!res.ok) return [];
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  return [...doc.getElementsByTagName("item")].map((item) => ({
    name: guessSeriesName(xmlText(item, "title")),
    author: (xmlText(item, "dc:creator") || xmlText(item, "author")).split(",")[0].trim(),
  })).filter((s) => s.name);
}
/* 複数の候補リストを重複なしでマージする */
function mergeSuggestionLists(lists, limit = 6) {
  const seen = new Set(); const out = [];
  for (const list of lists) for (const s of (list || [])) {
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name); out.push(s);
    if (out.length >= limit) return out;
  }
  return out;
}
/* プレフィックスキャッシュ: 「フリーレ」の結果を「フリーレン」入力時に絞って流用する */
function prefixCachedSuggestions(query) {
  let bestKey = "";
  for (const key of suggestionCache.keys()) {
    if (key && query.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  if (!bestKey) return [];
  const nq = normalizeText(query);
  return suggestionCache.get(bestKey).filter((s) => normalizeText(s.name).includes(nq));
}
/* 高速化: (1)通信なし候補を即表示 (2)Googleが700msで返らなければNDLも並行 (3)旧リクエストはabort */
async function fetchTitleSuggestions(query) {
  const seq = ++suggestSeq;
  const list = $("#suggestionList");
  if (!query || query.length < 2) { list.hidden = true; return; }
  if (suggestionCache.has(query)) return renderSuggestions(suggestionCache.get(query));
  const local = state.titles
    .filter((t) => normalizeText(t.name).includes(normalizeText(query)))
    .map((t) => ({ name: t.name, author: t.author || "" }));
  /* 第1段: 登録済み＋キャッシュ流用を即表示（通信を待たない） */
  const instant = mergeSuggestionLists([local, prefixCachedSuggestions(query)]);
  if (instant.length) renderSuggestions(instant);
  /* 前のリクエストは打ち切って帯域を空ける */
  suggestAbort?.abort();
  const abort = new AbortController(); suggestAbort = abort;
  /* 第2段: Google。700ms経っても返らなければNDLも並行して走らせる */
  let ndlPromise = null;
  const hedge = setTimeout(() => {
    ndlPromise = ndlSuggestions(query, abort.signal).catch(() => []);
  }, 700);
  let remote = [];
  try { remote = await googleSuggestions(query, abort.signal); } catch {}
  clearTimeout(hedge);
  if (!remote.length) {
    try { remote = await (ndlPromise || ndlSuggestions(query, abort.signal)); } catch {}
  }
  if (seq !== suggestSeq) return; /* もっと新しい入力があった */
  const result = mergeSuggestionLists([local, remote]);
  if (remote.length) suggestionCache.set(query, result);
  renderSuggestions(result);
}
function renderSuggestions(suggestions) {
  const list = $("#suggestionList"), input = $("#mangaTitle");
  suggestionItems = suggestions; suggestionIndex = -1;
  list.replaceChildren(...suggestions.map((s, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "suggestion-item"; b.setAttribute("role", "option");
    b.innerHTML = `<span></span><span class="s-author"></span>`;
    b.children[0].textContent = s.name;
    b.children[1].textContent = s.author || "";
    b.addEventListener("click", () => pickSuggestion(i));
    return b;
  }));
  list.hidden = suggestions.length === 0;
  input.setAttribute("aria-expanded", String(suggestions.length > 0));
}
function pickSuggestion(i) {
  const s = suggestionItems[i]; if (!s) return;
  $("#mangaTitle").value = s.name;
  if (s.author) $("#mangaAuthor").value = s.author;
  $("#suggestionList").hidden = true;
  $("#mangaTitle").setAttribute("aria-expanded", "false");
}
const debouncedSuggestions = debounce((v) => fetchTitleSuggestions(v.trim()), 250);

/* ============================================================
   描画
   ============================================================ */
const els = {};
["hero","timeline","noticeList","noticeSummary","mangaList","titleBadge","calendar","monthLabel",
 "toast","toastText","toastUndo","detailBody","candidateList","syncStatus"].forEach((id) => els[id] = document.getElementById(id));
let toastTimer = null, undoAction = null;
function showToast(message, undo) {
  els.toastText.textContent = message;
  undoAction = undo || null;
  els.toastUndo.hidden = !undo;
  els.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 5000);
}
els.toastUndo.addEventListener("click", () => {
  if (undoAction) { undoAction(); save(); }
  els.toast.classList.remove("visible"); render();
});
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* 修正: URLをエスケープしてからHTMLに入れる */
function coverHTML(url, title) {
  return url ? `<img src="${esc(String(url).replace(/^http:/, "https:"))}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;cover-fallback&quot;>📖</div>'">`
    : `<div class="cover-fallback" aria-hidden="true">📖</div>`;
}
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

function render() { renderHome(); renderLibrary(); renderCalendar(); renderSettingsBadge(); }
function renderStats() {
  const box = $("#collectionStats"); if (!box) return;
  const now = new Date();
  const thisMonth = upcomingReleases().filter((r) => {
    const d = dateOnly(r.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const spend = thisMonth.reduce((sum, r) => sum + (r.price?.amount || 0), 0);
  const stats = [
    ["登録シリーズ", `${state.titles.length}`],
    ["追跡中の発売予定", `${upcomingReleases().length}`],
    ["今月の新刊", `${thisMonth.length}冊`],
    ["今月の合計（判明分）", spend ? `¥${spend.toLocaleString("ja-JP")}` : "—"],
  ];
  box.replaceChildren(...stats.map(([label, value]) =>
    el(`<div class="stat"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`)));
}
function renderSettingsBadge() {
  els.titleBadge.hidden = state.titles.length === 0;
  els.titleBadge.textContent = state.titles.length || "";
}
function renderHome() {
  renderStats();
  const upcoming = upcomingReleases();
  const next = upcoming[0];
  if (next) {
    const t = titleFor(next.titleId);
    const d = daysUntil(next.date);
    els.hero.replaceChildren(el(`<article class="hero">
      ${coverHTML(next.thumbnailUrl || t?.thumbnailUrl, t?.name)}
      <div class="hero-info">
        <p class="hero-label">次に買う1冊</p>
        <p class="hero-title">${esc(t?.name || "")} ${esc(next.volume)}巻</p>
        <p class="hero-count">${d === 0 ? "今日" : `あと${d}<small>日</small>`}</p>
        <p class="hero-date">${esc(fmtDate.format(dateOnly(next.date)))} 発売${next.price ? " ・ " + esc(formatPrice(next.price)) : ""}</p>
      </div></article>`));
  } else {
    els.hero.replaceChildren(el(`<div class="hero-empty">
      <strong>まだ発売予定がありません</strong>
      <p>作品を登録すると、次に買う1冊がここに大きく表示されます。</p></div>`));
  }
  const groups = [["今週", (d) => d <= 7], ["今月", (d) => d <= 31], ["それ以降", () => true]];
  const used = new Set(); const frag = document.createDocumentFragment();
  if (!upcoming.length) {
    frag.append(el(`<div class="empty-state"><strong>発売予定はまだありません</strong><span>右下の「＋追加」から作品を登録してください。</span></div>`));
  }
  for (const [label, test] of groups) {
    const rows = upcoming.filter((r) => !used.has(r.id) && test(daysUntil(r.date)));
    rows.forEach((r) => used.add(r.id));
    if (!rows.length) continue;
    const g = el(`<p class="group-label">${label}</p>`); frag.append(g);
    rows.forEach((r) => frag.append(releaseRow(r)));
  }
  els.timeline.replaceChildren(frag);
  const notices = noticeReleases();
  els.noticeSummary.textContent = notices.length ? `${notices.length}件（${state.noticeDays}日前から）` : "";
  els.noticeList.replaceChildren(...(notices.length
    ? notices.map((r) => releaseRow(r))
    : [el(`<div class="empty-state"><span>${state.noticeDays}日以内に発売される作品はありません。</span></div>`)]));
}
function releaseRow(r) {
  const t = titleFor(r.titleId);
  const row = el(`<button type="button" class="row-card">
    ${coverHTML(r.thumbnailUrl || t?.thumbnailUrl, t?.name)}
    <span class="row-main"><span class="row-title">${esc(t?.name || "")} ${esc(r.volume)}巻</span><br>
    <span class="row-sub">${esc(fmtDate.format(dateOnly(r.date)))}${r.memo ? " ・ " + esc(r.memo) : ""}</span></span>
    <span class="row-side"><span class="chip ${urgencyClass(r.date)}">${esc(daysLabel(r.date))}</span></span>
  </button>`);
  row.addEventListener("click", () => openDetail(r.titleId));
  return row;
}
/* 修正5: 比較関数が必ず 0 を返せるよう localeCompare を使う */
function sortTitles(titles) {
  const sorted = [...titles];
  if (state.sortOrder === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  else if (state.sortOrder === "recentlyAdded") sorted.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else sorted.sort((a, b) => (nextReleaseDateFor(a.id) || "9999-12-31").localeCompare(nextReleaseDateFor(b.id) || "9999-12-31"));
  return sorted;
}
function renderLibrary() {
  const q = state.search.trim().toLowerCase();
  const matched = sortTitles(state.titles).filter((t) => {
    if (!q) return true;
    const rels = state.releases.filter((r) => r.titleId === t.id);
    return [t.name, t.author, ...rels.map((r) => r.memo || "")].join(" ").toLowerCase().includes(q);
  });
  if (!matched.length) {
    els.mangaList.replaceChildren(el(`<div class="empty-state"><strong>${state.titles.length ? "見つかりませんでした" : "まだ登録がありません"}</strong><span>${state.titles.length ? "検索のことばを変えてみてください。" : "右下の「＋追加」から最初の作品を登録してください。"}</span></div>`));
    return;
  }
  els.mangaList.replaceChildren(...matched.map((t) => {
    const nextDate = nextReleaseDateFor(t.id);
    const next = nextDate ? state.releases.find((r) => r.titleId === t.id && r.date === nextDate) : null;
    const count = state.releases.filter((r) => r.titleId === t.id).length;
    const card = el(`<button type="button" class="shelf-card">
      <span class="shelf-cover">${coverHTML(next?.thumbnailUrl || t.thumbnailUrl, t.name)}
        ${nextDate ? `<span class="chip ${urgencyClass(nextDate)} shelf-badge">${esc(daysLabel(nextDate))}</span>`
                   : `<span class="chip shelf-badge">次巻未確認</span>`}
      </span>
      <span class="shelf-title">${esc(t.name)}</span>
      <span class="shelf-sub">${esc(t.author || "")}</span>
      <span class="shelf-sub">${next ? `次は${esc(next.volume)}巻 ・ ${esc(nextDate)}` : `発売予定 ${count}件`}</span>
    </button>`);
    card.addEventListener("click", () => openDetail(t.id));
    return card;
  }));
  matched.forEach((t) => {
    ensureTitleCover(t);
    const nd = nextReleaseDateFor(t.id);
    const nr = nd ? state.releases.find((r) => r.titleId === t.id && r.date === nd) : null;
    if (nr) ensureReleaseCover(nr);
  });
}

/* ---------- 詳細 ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  $("#main").scrollTop = 0; window.scrollTo({ top: 0 });
}
function openDetail(titleId) {
  const t = titleFor(titleId); if (!t) return;
  closeDay(); /* 修正2: 日別ポップアップが開いていたら閉じる */
  state.currentTitleId = titleId;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-detail"));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === "library"));
  const rels = sortedReleases().filter((r) => r.titleId === titleId);
  const body = els.detailBody;
  body.replaceChildren(el(`<div>
    <div class="detail-head">${coverHTML(t.thumbnailUrl, t.name)}
      <div><h1 class="view-title" style="margin:0">${esc(t.name)}</h1>
      <p class="row-sub">${esc(t.author || "")}</p>
      <div class="detail-actions">
        <button class="mini-button" id="detailSync" type="button">新刊候補を取得</button>
        <button class="mini-button" id="detailEdit" type="button">作品名・作者を編集</button>
        <button class="mini-button danger" id="detailDelete" type="button">作品を削除</button>
      </div></div>
    </div>
    <div id="detailEditArea"></div>
        <p class="sync-status" id="detailSyncStatus" role="status"></p>
    <div id="detailCandidates"></div>
    <h2 style="margin:18px 0 8px">発売予定</h2>
    <div id="detailReleases"></div>
    <h2 style="margin:18px 0 8px">発売日を手動で追加</h2>
    <form id="detailReleaseForm" class="settings-group" style="margin:0">
      <div class="field-row">
        <label class="field"><span>巻数</span><input id="dVolume" required inputmode="numeric"></label>
        <label class="field"><span>発売日</span><input id="dDate" required type="date"></label>
      </div>
      <label class="field"><span>メモ（任意）</span><input id="dMemo"></label>
      <button class="secondary-button" type="submit">追加する</button>
    </form></div>`));
  /* 詳細ヘッダーの表紙タップで拡大表示 */
  const headCover = body.querySelector(".detail-head img");
  if (headCover && t.thumbnailUrl) {
    headCover.classList.add("zoomable");
    headCover.title = "タップで拡大";
    headCover.addEventListener("click", () => openLightbox(t.thumbnailUrl, t));
  }
  const list = $("#detailReleases");
  list.replaceChildren(...(rels.length ? rels.map((r) => {
    const row = el(`<div class="row-card" style="cursor:default">
      ${coverHTML(r.thumbnailUrl || t.thumbnailUrl, t.name)}
      <span class="row-main"><span class="row-title">${esc(r.volume)}巻</span><br>
      <span class="row-sub">${esc(fmtDate.format(dateOnly(r.date)))} ・ ${esc(daysLabel(r.date))}${r.memo ? " ・ " + esc(r.memo) : ""}${r.price ? " ・ " + esc(formatPrice(r.price)) : ""}</span></span>
      <button class="mini-button danger" type="button">削除</button></div>`);
    const rowCover = row.querySelector("img");
    if (rowCover) rowCover.addEventListener("click", () => openLightbox(r.thumbnailUrl || t.thumbnailUrl, t));
    row.querySelector("button").addEventListener("click", () => {
      const snapshot = { ...r };
      state.releases = state.releases.filter((x) => x.id !== r.id);
      showToast("発売予定を削除しました", () => { state.releases.push(snapshot); });
      save(); render(); openDetail(titleId);
    });
    return row;
  }) : [el(`<div class="empty-state"><span>発売予定はまだありません。下のフォームか「新刊候補を取得」から追加できます。</span></div>`)]));
  /* 修正1: 残っている候補を描画し直す */
  renderCandidateCards($("#detailCandidates"), titleId);
  $("#detailBack").onclick = () => { switchTab("library"); renderLibrary(); };
  $("#detailDelete").addEventListener("click", () => {
    if (!confirm(`「${t.name}」とその発売予定をすべて削除します。よろしいですか？`)) return;
    const snapT = { ...t };
    const snapR = state.releases.filter((r) => r.titleId === t.id).map((r) => ({ ...r }));
    const snapC = state.candidates.filter((c) => c.titleId === t.id).map((c) => ({ ...c }));
    state.titles = state.titles.filter((x) => x.id !== t.id);
    state.releases = state.releases.filter((r) => r.titleId !== t.id);
    state.candidates = state.candidates.filter((c) => c.titleId !== t.id);
    showToast("作品を削除しました", () => {
      state.titles.push(snapT);
      state.releases.push(...snapR);
      state.candidates.push(...snapC);
    });
    switchTab("library"); save(); render();
  });
  $("#detailEdit").addEventListener("click", () => {
    const area = $("#detailEditArea");
    const form = el(`<form class="settings-group"><label class="field"><span>作品名</span>
      <input id="eName" required value="${esc(t.name)}"></label>
      <label class="field"><span>作者</span><input id="eAuthor" value="${esc(t.author || "")}"></label>
      <button class="secondary-button" type="submit">保存する</button></form>`);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#eName").value.trim();
      if (!name) { showToast("作品名を入力してください"); return; }
      if (state.titles.some((x) => x.id !== t.id && normalizeText(x.name) === normalizeText(name))) {
        showToast("同じ作品名がすでに登録されています"); return;
      }
      t.name = name; t.author = $("#eAuthor").value.trim();
      showToast("保存しました"); save(); render(); openDetail(t.id);
    });
    area.replaceChildren(form); $("#eName").focus();
  });
  $("#detailSync").addEventListener("click", async () => {
    const st = $("#detailSyncStatus"); st.textContent = "候補を検索しています…";
    const holder = $("#detailCandidates");
    try {
      const found = await searchTitleCandidates(t);
      mergeCandidates(found);
      st.textContent = found.length ? `${found.length}件の候補が見つかりました。` : "候補は見つかりませんでした。";
      renderCandidateCards(holder, t.id);
    } catch (e) { st.textContent = e.message; }
  });
  $("#detailReleaseForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const volume = $("#dVolume").value.trim(), date = normalizeDate($("#dDate").value);
    if (!volume || !date) { showToast("巻数と発売日を確認してください"); return; }
    if (releaseExists({ titleId: t.id, volume, date })) { showToast("同じ巻数・発売日はすでに登録されています"); return; }
    state.releases.push({ id: uid(), titleId: t.id, volume, date, memo: $("#dMemo").value.trim(), price: null, isbn: "", sourceId: "", thumbnailUrl: "" });
    showToast("発売予定を追加しました"); save(); render(); openDetail(t.id);
  });
}
function candidateCard(c) {
  const card = el(`<article class="candidate">
    ${coverHTML(c.thumbnail, c.bookTitle)}
    <div class="candidate-main"><div class="row-title">${esc(c.bookTitle)}</div>
    <div class="row-sub">${esc(c.volume)}巻 ・ ${esc(c.date)}（${esc(daysLabel(c.date))}） ・ ${esc(c.sourceLabel)}${c.price ? " ・ " + esc(formatPrice(c.price)) : ""}</div>
    <div class="score-bar" aria-label="当てはまり度 ${c.score}"><i style="width:${Math.min(100, Math.max(0, c.score))}%"></i></div></div>
    <button class="secondary-button" type="button">取り込む</button></article>`);
  card.querySelector("button").addEventListener("click", () => importCandidate(c.id));
  return card;
}
function renderCandidateCards(holder, titleId) {
  if (!holder) return;
  const list = state.candidates.filter((c) => c.titleId === titleId);
  holder.replaceChildren(...list.map(candidateCard));
}
function renderCandidates() {
  renderCandidateCards(els.candidateList, state.sheetTitleId);
}
function importCandidate(candidateId) {
  const c = state.candidates.find((x) => x.id === candidateId);
  if (!c || !c.date) return;
  if (!releaseExists(c)) {
    state.releases.push({ id: uid(), titleId: c.titleId, volume: c.volume, date: c.date,
      memo: c.memo, price: c.price || null, isbn: c.isbn || "", sourceId: c.sourceId,
      thumbnailUrl: c.thumbnail || "", thumbnailConfirmed: Boolean(c.thumbnail) });
    const t = titleFor(c.titleId);
    if (t && !t.thumbnailUrl && c.thumbnail) t.thumbnailUrl = c.thumbnail;
  }
  state.candidates = state.candidates.filter((x) => x.id !== candidateId);
  state.calendarDate = dateOnly(c.date);
  save();
  showToast("発売予定に取り込みました");
  render(); renderCandidates(); renderBulkResults();
  if (state.currentTitleId === c.titleId && $("#view-detail").classList.contains("is-active")) openDetail(c.titleId);
}

/* ---------- カレンダー ---------- */
function renderCalendar() {
  const y = state.calendarDate.getFullYear(), m = state.calendarDate.getMonth();
  els.monthLabel.textContent = `${y}年${m + 1}月`;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const cells = ["日","月","火","水","木","金","土"].map((d) => el(`<div class="cal-weekday">${d}</div>`));
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const key = isoDate(day);
    const hits = state.releases.filter((r) => r.date === key);
    const cell = el(`<button type="button" class="cal-day ${day.getMonth() !== m ? "is-out" : ""} ${key === isoDate(new Date()) ? "is-today" : ""}">
      <span>${day.getDate()}</span>${hits.length ? `<span class="dots">${hits.slice(0, 3).map(() => `<span class="dot"></span>`).join("")}</span><span class="cal-count">${hits.length}冊</span>` : ""}</button>`);
    cell.addEventListener("click", () => openDay(key, hits));
    cells.push(cell);
  }
  els.calendar.replaceChildren(...cells);
}
function openDay(key, hits) {
  $("#dayTitle").textContent = fmtDate.format(dateOnly(key)) + " の発売";
  const body = $("#dayDetail");
  body.replaceChildren(...(hits.length ? hits.map((r) => releaseRow(r))
    : [el(`<div class="empty-state"><span>この日の発売予定はありません。</span></div>`)]));
  $("#dayOverlay").hidden = false;
}

/* ---------- シート開閉 ---------- */
/* 修正: 開くたびに前回の登録状態をリセットする */
function resetSheet() {
  state.sheetTitleId = null;
  const after = $("#sheetAfterAdd"); if (after) after.hidden = true;
  const form = $("#titleForm"); if (form) form.reset();
  const rform = $("#releaseForm"); if (rform) rform.reset();
  if (els.candidateList) els.candidateList.replaceChildren();
  if (els.syncStatus) els.syncStatus.textContent = "";
}
function openSheet() {
  resetSheet();
  $("#sheetOverlay").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#mangaTitle").focus(), 50);
}
function closeSheet() {
  $("#sheetOverlay").hidden = true;
  document.body.style.overflow = "";
  $("#suggestionList").hidden = true;
}
$("#fabAdd").addEventListener("click", openSheet);
$("#railAdd").addEventListener("click", openSheet);
$("#sheetClose").addEventListener("click", closeSheet);
$("#sheetDone").addEventListener("click", closeSheet);
$("#sheetOverlay").addEventListener("click", (e) => { if (e.target.id === "sheetOverlay") closeSheet(); });
function closeDay() { $("#dayOverlay").hidden = true; }
$("#dayClose").addEventListener("click", closeDay);
$("#dayOverlay").addEventListener("click", (e) => { if (e.target.id === "dayOverlay") closeDay(); });
/* ---------- 表紙の拡大表示 ---------- */
/* Google Books の表紙は zoom=0 で大きい版が返ることがあるので、拡大時だけ差し替える */
function hiResCoverUrl(url) {
  const u = String(url || "").replace(/^http:/, "https:");
  if (!u.includes("books.google")) return u;
  return u.replace(/([?&])zoom=\d/, "$1zoom=0").replace(/&edge=curl/g, "");
}
let lightboxToken = 0;
/* ---------- 別レコードの高解像度表紙を探す ----------
   Google Books では同じ本でも複数のレコードがあり、大きい表紙（zoom=0）が
   実物のレコードとプレースホルダーのレコードが混在する。現在のレコードに
   大きい表紙が無い場合、ISBN・書名から別レコードを探して付け替える */
function googleIdFromUrl(url) {
  const m = String(url || "").match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function googleCoverUrl(id, zoom) {
  return `https://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=${zoom}&source=gbs_api`;
}
function probeImageSize(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const im = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    im.onload = () => { clearTimeout(timer); resolve({ w: im.naturalWidth, h: im.naturalHeight }); };
    im.onerror = () => { clearTimeout(timer); resolve(null); };
    im.src = url;
  });
}
const isPlaceholderSize = (s) => Boolean(s) && s.w === 575 && s.h === 750;
async function googleBookFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("google books " + res.status);
  return res.json();
}
async function googleVolumeById(id) {
  const params = new URLSearchParams({ fields: "volumeInfo(title,authors,industryIdentifiers)" });
  const gk = usableGoogleKey(); if (gk) params.set("key", gk);
  return googleBookFetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}?${params.toString()}`);
}
async function googleVolumeSearch(q) {
  const params = new URLSearchParams({ q, printType: "books", langRestrict: "ja", maxResults: "10", country: "JP",
    fields: "items(id,volumeInfo(title,authors,imageLinks))" });
  const gk = usableGoogleKey(); if (gk) params.set("key", gk);
  return googleBookFetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);
}
async function findAltCoverRecord(title, currentUrl) {
  const id0 = googleIdFromUrl(currentUrl);
  if (!id0 || !title) return null;
  const deadline = Date.now() + 9000;
  let vol0 = "", isbn = "";
  try {
    const info = (await googleVolumeById(id0))?.volumeInfo || {};
    vol0 = extractVolume(info.title || "", title.name);
    const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
    isbn = (ids.find((x) => x.type === "ISBN_13") || ids.find((x) => x.type === "ISBN_10") || {}).identifier || "";
  } catch { /* レコード情報が取れなくても書名検索で続行 */ }
  const queries = [];
  if (isbn) queries.push(`isbn:${isbn}`);
  const titleQuery = [`intitle:${title.name}`];
  if (title.author) titleQuery.push(`inauthor:${title.author}`);
  queries.push(titleQuery.join(" "));
  const seen = new Set([id0]);
  const candidates = [];
  for (const q of queries) {
    if (candidates.length >= 6 || Date.now() > deadline) break;
    let data;
    try { data = await googleVolumeSearch(q); } catch { continue; }
    for (const item of (Array.isArray(data.items) ? data.items : [])) {
      if (!item.id || seen.has(item.id)) continue;
      const info = item.volumeInfo || {};
      if (!info.imageLinks?.thumbnail && !info.imageLinks?.smallThumbnail) continue;
      const nt = normalizeText(info.title || ""), nname = normalizeText(title.name);
      const itemVol = extractVolume(info.title || "", title.name);
      const titleOk = nt === nname || nt.startsWith(nname) || Boolean(itemVol);
      const volOk = !vol0 || !itemVol || itemVol === vol0;
      const authorOk = !title.author || !(info.authors || []).length
        || (info.authors || []).some((a) => normalizeText(a).includes(normalizeText(title.author)) || normalizeText(title.author).includes(normalizeText(a)));
      if (titleOk && volOk && authorOk) { seen.add(item.id); candidates.push(item.id); }
    }
  }
  for (const id of candidates.slice(0, 6)) {
    if (Date.now() > deadline) break;
    const size = await probeImageSize(googleCoverUrl(id, 0));
    if (size && !isPlaceholderSize(size)) return { thumbUrl: googleCoverUrl(id, 1), hiUrl: googleCoverUrl(id, 0) };
  }
  return null;
}
function openLightbox(url, title) {
  if (!url) return;
  const img = $("#lightboxImg");
  const original = String(url).replace(/^http:/, "https:");
  const token = ++lightboxToken;
  img.onerror = null;
  img.removeAttribute("src");
  img.style.opacity = "0"; /* 大きい版の判定が終わるまで表示しない */
  $("#lightbox").hidden = false;
  const show = (srcToShow) => {
    if (token !== lightboxToken) return;
    img.src = srcToShow;
    img.style.opacity = "1";
  };
  const hi = hiResCoverUrl(original);
  if (hi === original) { show(original); return; }
  /* 元画像は裏で読み込んでおき、大きい版がダメな場合の受け先にする */
  const origProbe = new Image();
  origProbe.src = original;
  (async () => {
    const size = await probeImageSize(hi, 6000);
    if (token !== lightboxToken) return;
    if (size && !isPlaceholderSize(size)) { show(hi); return; }
    /* 現在のレコードに大きい表紙が無い → 別レコードを探す（30日間は再探索しない） */
    const checkedAt = Number(title?.coverAltCheckedAt || 0);
    if (title && googleIdFromUrl(original) && Date.now() - checkedAt > 30 * 24 * 3600 * 1000) {
      const alt = await findAltCoverRecord(title, original).catch(() => null);
      if (token !== lightboxToken) return;
      if (alt) {
        title.thumbnailUrl = alt.thumbUrl; /* 良いレコードに付け替えて保存し、次回から直接使う */
        save();
        show(alt.hiUrl);
        return;
      }
      title.coverAltCheckedAt = Date.now();
      save();
    }
    show(original);
  })();
}
function closeLightbox() {
  lightboxToken++;
  $("#lightbox").hidden = true;
  const img = $("#lightboxImg");
  img.removeAttribute("src");
  img.style.opacity = "0";
}
$("#lightboxClose").addEventListener("click", closeLightbox);
$("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });

/* ---------- キーボードショートカット ---------- */
function openShortcutHelp() { $("#helpOverlay").hidden = false; }
function closeShortcutHelp() { $("#helpOverlay").hidden = true; }
$("#helpClose").addEventListener("click", closeShortcutHelp);
$("#helpOverlay").addEventListener("click", (e) => { if (e.target.id === "helpOverlay") closeShortcutHelp(); });
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return; /* 日本語変換中は誤発動させない */
  if (e.key === "Escape") {
    closeSheet(); closeDay(); closeShortcutHelp(); closeLightbox();
    document.body.style.overflow = "";
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return; /* ブラウザ/OSの操作を奪わない */
  const target = e.target;
  const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || target?.isContentEditable;
  if (editing) return; /* 入力中は Esc 以外無効 */
  /* 何か開いている間は Esc 以外無効（? でヘルプを閉じる操作だけ許可） */
  const anyOpen = !$("#sheetOverlay").hidden || !$("#dayOverlay").hidden || !$("#lightbox").hidden;
  if (e.key === "?") {
    e.preventDefault();
    if ($("#helpOverlay").hidden) openShortcutHelp(); else closeShortcutHelp();
    return;
  }
  if (anyOpen || !$("#helpOverlay").hidden) return;
  switch (e.key) {
    case "/": {
      e.preventDefault();
      switchTab("library");
      const input = $("#searchInput");
      input.focus(); input.select();
      break;
    }
    case "n":
      e.preventDefault();
      openSheet();
      break;
    case "1": switchTab("home"); render(); break;
    case "2": switchTab("library"); render(); break;
    case "3": switchTab("calendar"); render(); break;
    case "4": switchTab("settings"); render(); break;
  }
});

/* ---------- 作品登録フォーム + オートコンプリート ---------- */
const titleInput = $("#mangaTitle");
titleInput.addEventListener("input", (e) => debouncedSuggestions(e.target.value));
titleInput.addEventListener("focus", (e) => { if (e.target.value.trim().length >= 2) debouncedSuggestions(e.target.value); });
titleInput.addEventListener("keydown", (e) => {
  const list = $("#suggestionList");
  if (list.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggestionIndex = e.key === "ArrowDown"
      ? Math.min(suggestionIndex + 1, suggestionItems.length - 1)
      : Math.max(suggestionIndex - 1, 0);
    [...list.children].forEach((c, i) => c.classList.toggle("is-selected", i === suggestionIndex));
  } else if (e.key === "Enter" && suggestionIndex >= 0) {
    e.preventDefault(); pickSuggestion(suggestionIndex);
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".autocomplete-field")) $("#suggestionList").hidden = true;
});
$("#titleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = titleInput.value.trim();
  const author = $("#mangaAuthor").value.trim();
  if (!name) return;
  /* 修正: 全角/半角・大文字小文字・空白の違いを無視して重複判定 */
  let t = state.titles.find((x) => normalizeText(x.name) === normalizeText(name));
  if (!t) {
    t = { id: uid(), name, author, thumbnailUrl: "", createdAt: Date.now() };
    state.titles.push(t);
    showToast(`「${name}」を登録しました`);
  } else { showToast(`「${t.name}」は登録済みです`); }
  state.sheetTitleId = t.id;
  save();
  ensureTitleCover(t);
  $("#sheetAfterAdd").hidden = false;
  $("#sheetSuccess").textContent = `「${t.name}」${t.author ? ` / ${t.author}` : ""} — 続けて発売日を追加するか、候補を取得してください。`;
  render();
  renderCandidates();
  $("#sheetAfterAdd").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#releaseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = titleFor(state.sheetTitleId); if (!t) return;
    const volume = $("#releaseVolume").value.trim();
  const date = normalizeDate($("#releaseDate").value);
  const rawPrice = $("#releasePrice").value.trim();
  const priceAmount = rawPrice ? Number(rawPrice) : null;
  if (!volume || !date || (rawPrice && (!Number.isFinite(priceAmount) || priceAmount < 0))) {
    showToast("発売日・巻数・価格を確認してください"); return;
  }
  if (releaseExists({ titleId: t.id, volume, date })) { showToast("同じ巻数・発売日はすでに登録されています"); return; }
  state.releases.push({ id: uid(), titleId: t.id, volume, date,
    memo: $("#releaseMemo").value.trim(),
    price: priceAmount ? { amount: priceAmount, currency: "JPY" } : null, isbn: "", sourceId: "", thumbnailUrl: "" });
  e.target.reset();
  showToast("発売予定を追加しました"); save(); render();
});
$("#syncButton").addEventListener("click", () => {
  const t = titleFor(state.sheetTitleId);
  if (t && !state.syncing) syncCandidatesFor(t);
});

/* ---------- 一括新刊チェック ---------- */
let bulkRunning = false, bulkCancel = false;
async function bulkCheck() {
  if (bulkRunning) { bulkCancel = true; return; }
  if (!state.titles.length) { showToast("先に作品を登録してください"); return; }
  bulkRunning = true; bulkCancel = false;
  const status = $("#bulkStatus");
  const buttons = [$("#bulkCheckHome"), $("#bulkCheckLibrary")];
  buttons.forEach((b) => { if (b) { b.textContent = "チェックを止める"; } });
  const before = state.candidates.length;
  let done = 0, failures = 0;
  const targets = [...state.titles]; /* 実行中に作品が増減してもずれないようコピー */
  for (const t of targets) {
    if (bulkCancel) { status.textContent = "一括チェックを中断しました。"; break; }
    status.textContent = `一括チェック中… ${done + 1}/${targets.length} 「${t.name}」`;
    try {
      const found = await searchTitleCandidates(t);
      mergeCandidates(found);
    } catch { failures++; }
    done++;
  }
  const added = Math.max(0, state.candidates.length - before);
  if (!bulkCancel) {
    status.textContent = failures
      ? `チェック完了: 新しい候補 ${added}件（${failures}作品は取得に失敗しました）`
      : `チェック完了: 新しい候補 ${added}件が見つかりました。`;
  }
  bulkRunning = false;
  buttons.forEach((b) => { if (b) b.textContent = b.id === "bulkCheckHome" ? "一括でチェック" : "🔄 登録作品を一括で新刊チェック"; });
  renderBulkResults();
  if (added > 0) showToast(`新刊候補が${added}件見つかりました`);
}
function renderBulkResults() {
  const box = $("#bulkResults"); if (!box) return;
  if (!state.candidates.length) { box.replaceChildren(); return; }
  const head = el(`<div class="section-head"><h2>新刊候補（${state.candidates.length}件）</h2>
    <button class="secondary-button" type="button">すべて取り込む</button></div>`);
  head.querySelector("button").addEventListener("click", () => {
    const ids = state.candidates.map((c) => c.id);
    ids.forEach((id) => importCandidate(id));
    showToast(`${ids.length}件を取り込みました`);
  });
  const groups = new Map();
  state.candidates.forEach((c) => {
    if (!groups.has(c.titleId)) groups.set(c.titleId, []);
    groups.get(c.titleId).push(c);
  });
  const frag = [head];
  for (const [titleId, list] of groups) {
    frag.push(el(`<p class="group-label">${esc(titleFor(titleId)?.name || "")}</p>`));
    list.forEach((c) => frag.push(candidateCard(c)));
  }
  box.replaceChildren(...frag);
}

/* ---------- 通知（ブラウザ内 + Discord任意） ---------- */
async function sendDiscord(message) {
  if (!state.discordWebhookUrl) return false;
  try {
    const res = await fetch(state.discordWebhookUrl, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }) });
    return res.ok;
  } catch { return false; }
}
/* 修正: 手動実行（force）のときは「1日1回」の制限を無視して必ず送る */
async function checkNotifications({ automatic = false, force = false } = {}) {
  const targets = noticeReleases();
  if (!targets.length) { if (!automatic) showToast("通知対象はありません"); return; }
  let notified = {};
  try { notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}"); } catch {}
  const todayKey = isoDate(new Date());
  let sent = 0;
  for (const r of targets) {
    const key = `${r.id}:${r.date}`;
    /* 旧バージョンで保存した通知済み記録との互換性を保つ */
    if (!force && notified[key] === todayKey) continue;
    const browserKey = `browser:${key}`;
    const discordKey = `discord:${key}`;
    const t = titleFor(r.titleId);
    const message = `📚 ${t?.name || ""} ${r.volume}巻 は ${daysLabel(r.date)}（${r.date}）`;
    let deliveredThisRelease = false;
    const browserEnabled = (state.autoNotify || force) && "Notification" in window && Notification.permission === "granted";
    const discordEnabled = (!automatic || state.autoNotify || force) && !!state.discordWebhookUrl;

    if (browserEnabled && (force || notified[browserKey] !== todayKey)) {
      try {
        new Notification("Books Book! 新刊のお知らせ", { body: message });
        notified[browserKey] = todayKey;
        deliveredThisRelease = true;
      } catch (error) {
        console.warn("ブラウザ通知を送信できませんでした", error);
      }
    }
    /* 自動実行時は自動通知設定が有効な場合だけ Discord に送る */
    if (discordEnabled && (force || notified[discordKey] !== todayKey)) {
      if (await sendDiscord(message)) {
        notified[discordKey] = todayKey;
        deliveredThisRelease = true;
      }
    }
    if (deliveredThisRelease) sent++;
  }
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified)); } catch {}
  if (!automatic) showToast(`${sent}件の通知を送りました`);
}

/* ---------- 設定・データ ---------- */
/* 修正: バックアップの中身を検証してから取り込む */
function sanitizeImport(parsed) {
  const titles = (Array.isArray(parsed.titles) ? parsed.titles : [])
    .filter((t) => t && typeof t.id === "string" && typeof t.name === "string");
  const ids = new Set(titles.map((t) => t.id));
  const releases = (Array.isArray(parsed.releases) ? parsed.releases : [])
    .map((r) => (r && ids.has(r.titleId) ? { ...r, date: normalizeDate(r.date), volume: String(r.volume ?? "?") } : null))
    .filter((r) => r && r.date)
    .map((r) => ({ ...r, id: r.id || uid() }));
  return { titles, releases };
}
function refreshSettingsFields() {
  $("#noticeDays").value = String(state.noticeDays);
  $("#autoNotify").checked = state.autoNotify;
  $("#googleApiKey").value = state.googleApiKey;
  $("#discordWebhook").value = state.discordWebhookUrl;
}
function bindSettings() {
  refreshSettingsFields();
  $("#noticeDays").addEventListener("change", (e) => { state.noticeDays = Number(e.target.value); save(); render(); });
  $("#autoNotify").addEventListener("change", async (e) => {
    state.autoNotify = e.target.checked;
    if (state.autoNotify && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    save(); renderHome();
  });
  $("#googleApiKey").addEventListener("change", (e) => {
    state.googleApiKey = e.target.value.trim(); suggestionCache.clear(); save();
    if (state.googleApiKey && !usableGoogleKey()) {
      showToast("APIキーの形式が正しくありません。キーなしとして扱います（空欄でも検索できます）");
    }
  });
  $("#discordWebhook").addEventListener("change", (e) => { state.discordWebhookUrl = e.target.value.trim(); save(); });
  $("#notifyNow").addEventListener("click", () => checkNotifications({ force: true }));
  $("#discordTest").addEventListener("click", async () => {
    if (!state.discordWebhookUrl) { showToast("Webhook URLを入力してください"); return; }
    showToast(await sendDiscord("📚 Books Book! テスト通知です。") ? "テスト通知を送信しました" : "送信に失敗しました。URLを確認してください");
  });
  $("#exportButton").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ titles: state.titles, releases: state.releases }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `books-book-backup-${isoDate(new Date())}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  $("#importInput").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.titles) || !Array.isArray(parsed.releases)) throw new Error("形式が違います");
      const clean = sanitizeImport(parsed);
      state.titles = clean.titles; state.releases = clean.releases; state.candidates = [];
      showToast(`バックアップを読み込みました（作品${clean.titles.length}件・発売予定${clean.releases.length}件）`); save(); render();
    } catch { showToast("読み込みに失敗しました。JSONバックアップを選んでください"); }
    e.target.value = "";
  });
  $("#clearAll").addEventListener("click", () => {
    if (!confirm("すべての作品・発売予定を削除します。本当によろしいですか？")) return;
    state.titles = []; state.releases = []; state.candidates = [];
    showToast("すべてのデータを削除しました"); save(); render(); renderBulkResults();
  });
}

$("#bulkCheckHome").addEventListener("click", bulkCheck);
$("#bulkCheckLibrary").addEventListener("click", () => { switchTab("home"); bulkCheck(); });

/* ---------- タブ・検索・カレンダー操作 ---------- */
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => { switchTab(b.dataset.tab); render(); }));
$("#homeToCalendar").addEventListener("click", () => switchTab("calendar"));
$("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderLibrary(); });
$("#sortOrder").addEventListener("change", (e) => { state.sortOrder = e.target.value; renderLibrary(); });
$("#prevMonth").addEventListener("click", () => { state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() - 1, 1); renderCalendar(); });
$("#nextMonth").addEventListener("click", () => { state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + 1, 1); renderCalendar(); });
$("#thisMonth").addEventListener("click", () => { state.calendarDate = dateOnly(new Date()); renderCalendar(); });

/* ---------- 起動 ---------- */
let settingsBound = false;
function bootApp(cloudData) {
  load(cloudData || null);
  if (!settingsBound) { bindSettings(); settingsBound = true; }
  else refreshSettingsFields();
  render();
  checkNotifications({ automatic: true });
}
if (window.BooksAuth?.start) window.BooksAuth.start(bootApp);
else bootApp(null); /* 認証が使えない環境ではローカルデータで起動 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { render(); checkNotifications({ automatic: true }); }
});
setInterval(() => checkNotifications({ automatic: true }), 15 * 60 * 1000);