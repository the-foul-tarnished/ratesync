// background.js - intercepts both Letterboxd rating endpoints

const pendingRatings = new Map();

function cleanupPending(details) {
  pendingRatings.delete(details.requestId);
}

async function getTmdbApiKey() {
  const { tmdbApiKey } = await chrome.storage.local.get("tmdbApiKey");
  if (!tmdbApiKey) throw new Error("TMDb API key not set. Click the extension icon and go to Settings.");
  return tmdbApiKey;
}

// Watch for film selection in LOG dialog: fires when user picks a film
// URL contains the numeric film ID we need later
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const match = details.url.match(/viewingableUID=film:(\d+)/);
    if (!match) return;
    pendingRatings.set(`tab-${details.tabId}`, { filmId: match[1], ts: Date.now() });
  },
  { urls: ["https://letterboxd.com/s/check-viewingable-relation*"] }
);

// Endpoint 1: film page rating - /s/film:XXXXX/rate/
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const match = details.url.match(/letterboxd\.com\/s\/film[:/](\d+)\/rate/);
    if (!match) return;

    const letterboxdFilmId = match[1];
    let rating = null;

    if (details.requestBody?.formData?.rating) {
      rating = parseInt(details.requestBody.formData.rating[0], 10);
    } else if (details.requestBody?.raw) {
      try {
        const raw = details.requestBody.raw[0]?.bytes;
        if (raw) {
          const text = new TextDecoder().decode(raw);
          const params = new URLSearchParams(text);
          rating = parseInt(params.get("rating"), 10);
        }
      } catch (e) {
        console.warn("[RateSync] Failed to parse film rating body:", e);
      }
    }

    if (rating != null && !isNaN(rating)) {
      const clampedRating = Math.min(10, Math.max(1, rating));
      pendingRatings.set(details.requestId, { type: "film", letterboxdFilmId, rating: clampedRating });
    }
  },
  { urls: ["https://letterboxd.com/s/*"] },
  ["requestBody"]
);

// Endpoint 2: log/diary entry - /api/v0/production-log-entries
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST" && details.method !== "PATCH") return;
    if (!details.url.includes("/api/v0/production-log-entries")) return;

    let productionId = null;
    let rating = null;

    if (details.requestBody?.raw) {
      try {
        const raw = details.requestBody.raw[0]?.bytes;
        if (raw) {
          const text = new TextDecoder().decode(raw);
          const body = JSON.parse(text);
          productionId = body.productionId;
          rating = body.rating;
        }
      } catch (e) {
        console.warn("[RateSync] Failed to parse log entry body:", e);
      }
    }

    if (productionId && rating != null && !isNaN(rating)) {
      const imdbRating = Math.min(10, Math.max(1, Math.round(rating * 2)));
      const tabKey = `tab-${details.tabId}`;
      const tabData = pendingRatings.get(tabKey);
      const letterboxdFilmId = (tabData && Date.now() - tabData.ts < 600000) ? tabData.filmId : null;
      pendingRatings.delete(tabKey);
      pendingRatings.set(details.requestId, {
        type: "production",
        productionId,
        letterboxdFilmId,
        rating: imdbRating,
      });
    }
  },
  { urls: ["https://letterboxd.com/api/v0/*"] },
  ["requestBody"]
);

// Handle completion for both endpoints
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pending = pendingRatings.get(details.requestId);
    if (!pending) return;
    pendingRatings.delete(details.requestId);
    if (details.statusCode < 200 || details.statusCode >= 300) return;

    const { rating } = pending;
    let filmTitle = null;

    try {
      let imdbId;

      if (pending.letterboxdFilmId) {
        ({ imdbId, filmTitle } = await getImdbIdFromLetterboxdFilmId(pending.letterboxdFilmId));
      } else {
        ({ imdbId, filmTitle } = await getImdbIdFromProductionSlug(pending.productionId));
      }

      if (!/^tt\d+$/.test(imdbId)) throw new Error(`Unexpected IMDb ID format: ${imdbId}`);

      await submitImdbRating(imdbId, rating);
      await logSync(filmTitle || imdbId, imdbId, rating, true);

      const { autoOpenImdb } = await chrome.storage.local.get("autoOpenImdb");
      if (autoOpenImdb) chrome.tabs.create({ url: `https://www.imdb.com/title/${imdbId}/` });
    } catch (err) {
      await logSync(filmTitle || "unknown", null, rating, false, err.message);
    }
  },
  { urls: ["https://letterboxd.com/s/*", "https://letterboxd.com/api/v0/*"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  cleanupPending,
  { urls: ["https://letterboxd.com/s/*", "https://letterboxd.com/api/v0/*"] }
);

async function resolveImdbId(url, label) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`Could not find IMDb ID for ${label} (HTTP ${resp.status}).`);
  const html = await resp.text();
  const titleMatch = html.match(/<title>([^<(|]+)/i);
  const filmTitle = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").replace(/&[^;]+;/g, "").trim() : null;
  const imdbMatch = html.match(/href=["']https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i);
  if (imdbMatch) return { imdbId: imdbMatch[1], filmTitle };
  const tmdbMatch = html.match(/href=["']https?:\/\/(?:www\.)?themoviedb\.org\/movie\/(\d+)/i);
  if (tmdbMatch) return { imdbId: await getImdbIdFromTmdb(tmdbMatch[1]), filmTitle };
  throw new Error(`Could not find IMDb ID for ${label}.`);
}

function getImdbIdFromLetterboxdFilmId(letterboxdFilmId) {
  return resolveImdbId(`https://letterboxd.com/film/film:${letterboxdFilmId}/details/`, `film ${letterboxdFilmId}`);
}

function getImdbIdFromProductionSlug(productionId) {
  if (!/^[\w-]+$/.test(productionId)) throw new Error(`Invalid productionId: ${productionId}`);
  return resolveImdbId(`https://letterboxd.com/film/${productionId}/details/`, `production ${productionId}`);
}

async function getImdbIdFromTmdb(tmdbId) {
  const apiKey = await getTmdbApiKey();
  const resp = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`TMDb API error: ${resp.status}`);
  const data = await resp.json();
  if (!data.imdb_id) throw new Error(`No IMDb ID on TMDb for movie ${tmdbId}`);
  return data.imdb_id;
}

async function getImdbCookies() {
  const [c1, c2] = await Promise.all([
    chrome.cookies.getAll({ domain: ".imdb.com" }),
    chrome.cookies.getAll({ domain: "www.imdb.com" }),
  ]);
  const atMain = [...c1, ...c2].find((c) => c.name === "at-main");
  if (!atMain) throw new Error("Not logged in to IMDb.");
  return atMain.value;
}

async function submitImdbRating(imdbId, rating) {
  const atMain = await getImdbCookies();

  const resp = await fetch("https://api.graphql.imdb.com/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${atMain}`,
    },
    credentials: "include",
    body: JSON.stringify({
      operationName: "UpdateTitleRating",
      query: `mutation UpdateTitleRating($rating: Int!, $titleId: ID!) {
        rateTitle(input: {rating: $rating, titleId: $titleId}) {
          rating { value }
        }
      }`,
      variables: { rating, titleId: imdbId },
    }),
  });

  if (!resp.ok) throw new Error(`IMDb GraphQL failed: ${resp.status}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`IMDb returned non-JSON response (status ${resp.status})`);
  }
  if (data.errors) throw new Error(`IMDb GraphQL error: ${data.errors[0].message}`);
  return data;
}

async function logSync(filmTitle, imdbId, rating, success, error = null) {
  const { syncLog = [] } = await chrome.storage.local.get("syncLog");
  syncLog.unshift({ filmTitle, imdbId, rating, success, error, timestamp: Date.now() });
  await chrome.storage.local.set({ syncLog: syncLog.slice(0, 100) });
}

async function updateBadge() {
  const cookies = await chrome.cookies.getAll({ domain: ".imdb.com" });
  const loggedIn = cookies.some((c) => c.name === "at-main");
  chrome.action.setBadgeText({ text: loggedIn ? "" : "•" });
  chrome.action.setBadgeBackgroundColor({ color: "#FFC107" });
}

chrome.runtime.onInstalled.addListener(() => updateBadge().catch(() => {}));
chrome.runtime.onStartup.addListener(() => updateBadge().catch(() => {}));
updateBadge().catch(() => {});

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.cookie.domain.includes("imdb.com") && changeInfo.cookie.name === "at-main") {
    updateBadge().catch(() => {});
  }
});
