// popup.js

async function checkImdbLogin() {
  const [c1, c2] = await Promise.all([
    chrome.cookies.getAll({ domain: ".imdb.com" }),
    chrome.cookies.getAll({ domain: "www.imdb.com" }),
  ]);
  return c1.some((c) => c.name === "at-main") || c2.some((c) => c.name === "at-main");
}

function renderStars(rating) {
  const val   = rating / 2;
  const full  = Math.floor(val);
  const half  = (val % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return (
    '<span class="log-stars">' +
    '<span class="star-full">★</span>'.repeat(full) +
    (half ? '<span class="star-half">★</span>' : '') +
    '<span class="star-empty">★</span>'.repeat(empty) +
    '</span>'
  );
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function render() {
  const dot         = document.getElementById("statusDot");
  const statusText  = document.getElementById("statusText");
  const loginLink   = document.getElementById("loginLink");
  const logList     = document.getElementById("logList");
  const totalCount  = document.getElementById("totalCount");
  const settingsBtn = document.getElementById("settingsBtn");

  const [loggedIn, { syncLog = [], tmdbApiKey, showFailedOnly = false, showUniqueOnly = false }] = await Promise.all([
    checkImdbLogin(),
    chrome.storage.local.get(["syncLog", "tmdbApiKey", "showFailedOnly", "showUniqueOnly"]),
  ]);

  const pill = document.querySelector(".status-pill");
  if (loggedIn) {
    dot.className = "dot ok";
    statusText.textContent = "IMDb connected";
    loginLink.style.display = "none";
    pill.style.cursor = "";
    pill.onclick = null;
  } else {
    dot.className = "dot warn";
    statusText.textContent = "Log in to IMDb";
    loginLink.style.display = "none";
    pill.style.cursor = "pointer";
    pill.onclick = () => chrome.tabs.create({ url: "https://www.imdb.com/login" });
  }

  settingsBtn.classList.toggle("needs-config", !tmdbApiKey);
  document.getElementById("tmdbNotice").classList.toggle("visible", !tmdbApiKey);
  document.getElementById("tmdbWrap").style.display = tmdbApiKey ? "none" : "";

  const statsBar = document.getElementById("statsBar");
  if (syncLog.length > 0) {
    const successful = syncLog.filter(e => e.success);
    const successRate = Math.round((successful.length / syncLog.length) * 100);
    const avgRating = successful.length
      ? (successful.reduce((sum, e) => sum + e.rating, 0) / successful.length / 2).toFixed(1)
      : null;
    document.getElementById("statTotal").textContent = syncLog.length;
    document.getElementById("statSuccess").textContent = `${successRate}%`;
    document.getElementById("statAvg").textContent = avgRating ? `★ ${avgRating}/5` : "—";
    statsBar.classList.add("visible");
  } else {
    statsBar.classList.remove("visible");
  }

  let filteredLog = showFailedOnly ? syncLog.filter(e => !e.success) : syncLog;
  if (showUniqueOnly) {
    const seen = new Set();
    filteredLog = filteredLog.filter(e => {
      const key = e.imdbId || e.filmTitle;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (filteredLog.length === 0) {
    logList.innerHTML = `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">${showFailedOnly ? "✓" : "&starf;"}</div>
        ${showFailedOnly ? "No failed syncs." : "No syncs yet.<br>Rate a film on Letterboxd."}
      </div>`;
    totalCount.textContent = "";
  } else {
    totalCount.textContent = `${filteredLog.length} total`;

    logList.innerHTML = "";
    filteredLog.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "log-item";

      const statusDot = document.createElement("div");
      statusDot.className = `log-status ${entry.success ? "ok" : "err"}`;

      const body = document.createElement("div");
      body.className = "log-body";

      const title = document.createElement("span");
      title.className = "log-title";
      title.textContent = entry.filmTitle || entry.imdbId;
      body.appendChild(title);

      if (!entry.success && entry.error) {
        const errEl = document.createElement("div");
        errEl.className = "log-error";
        errEl.textContent = entry.error;
        body.appendChild(errEl);
      }

      const meta = document.createElement("span");
      meta.className = "log-meta";
      meta.innerHTML = `${renderStars(entry.rating)}<span class="log-time">${timeAgo(entry.timestamp)}</span>`;

      if (entry.imdbId && /^tt\d+$/.test(entry.imdbId)) {
        item.classList.add("clickable");
        item.addEventListener("click", () => {
          chrome.tabs.create({ url: `https://www.imdb.com/title/${entry.imdbId}/` });
        });
      }

      item.append(statusDot, body, meta);
      logList.appendChild(item);
    });
  }
}

// Re-render when user returns to the popup after logging into IMDb in another tab
window.addEventListener("focus", render);

// ── Clear log (two-click confirmation) ──
const clearBtn = document.getElementById("clearBtn");
let clearPending = false;
let clearTimer = null;

clearBtn.addEventListener("click", async () => {
  if (!clearPending) {
    clearPending = true;
    clearBtn.textContent = "Sure?";
    clearBtn.classList.add("confirm");
    clearTimer = setTimeout(() => {
      clearPending = false;
      clearBtn.textContent = "Clear";
      clearBtn.classList.remove("confirm");
    }, 2500);
    return;
  }
  clearTimeout(clearTimer);
  clearPending = false;
  clearBtn.textContent = "Clear";
  clearBtn.classList.remove("confirm");
  await chrome.storage.local.set({ syncLog: [] });
  render();
});

// ── Settings panel ──
const settingsBtn     = document.getElementById("settingsBtn");
const backBtn         = document.getElementById("backBtn");
const mainView        = document.getElementById("mainView");
const settingsSection = document.getElementById("settingsSection");
const tmdbKeyInput    = document.getElementById("tmdbKeyInput");
const saveKeyBtn      = document.getElementById("saveKeyBtn");
const saveStatus      = document.getElementById("saveStatus");
const removeKeyBtn    = document.getElementById("removeKeyBtn");

async function openSettings() {
  mainView.style.display = "none";
  settingsSection.classList.add("visible");
  settingsBtn.classList.add("active");
  const { tmdbApiKey, showFailedOnly = false, showUniqueOnly = false, autoOpenImdb = false } = await chrome.storage.local.get(["tmdbApiKey", "showFailedOnly", "showUniqueOnly", "autoOpenImdb"]);
  if (tmdbApiKey) tmdbKeyInput.value = tmdbApiKey;
  removeKeyBtn.style.display = tmdbApiKey ? "" : "none";
  document.getElementById("failedOnlyToggle").checked = showFailedOnly;
  document.getElementById("uniqueOnlyToggle").checked = showUniqueOnly;
  document.getElementById("autoOpenToggle").checked = autoOpenImdb;
}

function closeSettings() {
  settingsSection.classList.remove("visible");
  mainView.style.display = "";
  settingsBtn.classList.remove("active");
}

settingsBtn.addEventListener("click", () => {
  settingsSection.classList.contains("visible") ? closeSettings() : openSettings();
});

backBtn.addEventListener("click", closeSettings);

document.getElementById("failedOnlyToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ showFailedOnly: e.target.checked });
  render();
});

document.getElementById("uniqueOnlyToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ showUniqueOnly: e.target.checked });
  render();
});

document.getElementById("autoOpenToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ autoOpenImdb: e.target.checked });
});

removeKeyBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("tmdbApiKey");
  tmdbKeyInput.value = "";
  removeKeyBtn.style.display = "none";
  settingsBtn.classList.add("needs-config");
  document.getElementById("tmdbNotice").classList.add("visible");
  document.getElementById("tmdbWrap").style.display = "";
  saveStatus.textContent = "Token removed.";
  saveStatus.className = "settings-status ok";
  setTimeout(() => { saveStatus.textContent = ""; }, 2000);
});

document.getElementById("toggleVisibility").addEventListener("click", () => {
  const input = document.getElementById("tmdbKeyInput");
  const icon  = document.getElementById("eyeIcon");
  const show  = input.type === "password";
  input.type  = show ? "text" : "password";
  icon.innerHTML = show
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
  document.getElementById("toggleVisibility").setAttribute("aria-label", show ? "Hide API key" : "Show API key");
});

document.getElementById("tmdbHowToBtn").addEventListener("click", () => {
  const el  = document.getElementById("tmdbInstructions");
  const btn = document.getElementById("tmdbHowToBtn");
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "";
  btn.textContent  = open ? "How to get one? ▸" : "How to get one? ▾";
});

document.getElementById("kofiBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://ko-fi.com/thefoultarnished" });
});

document.getElementById("loginLink").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.imdb.com/login" });
});

document.getElementById("tmdbHomeLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.themoviedb.org" });
});

document.getElementById("tmdbApiLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.themoviedb.org/settings/api" });
});

saveKeyBtn.addEventListener("click", async () => {
  const key = tmdbKeyInput.value.trim();
  if (!key) {
    saveStatus.textContent = "Token cannot be empty.";
    saveStatus.className = "settings-status err";
    return;
  }

  saveKeyBtn.disabled = true;
  saveStatus.textContent = "Validating…";
  saveStatus.className = "settings-status";

  try {
    const resp = await fetch(`https://api.themoviedb.org/3/authentication`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error();
  } catch {
    saveStatus.textContent = "Invalid token.";
    saveStatus.className = "settings-status err";
    saveKeyBtn.disabled = false;
    return;
  }

  await chrome.storage.local.set({ tmdbApiKey: key });
  saveStatus.textContent = "Saved.";
  saveStatus.className = "settings-status ok";
  settingsBtn.classList.remove("needs-config");
  document.getElementById("tmdbNotice").classList.remove("visible");
  document.getElementById("tmdbWrap").style.display = "none";
  removeKeyBtn.style.display = "";
  saveKeyBtn.disabled = false;
  setTimeout(() => { saveStatus.textContent = ""; }, 2000);
});

render();
