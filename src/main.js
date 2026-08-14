// Vanilla JS frontend. No bundler assumed — relies on `withGlobalTauri: true`
// in tauri.conf.json so `window.__TAURI__` is available.

const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const { open } = window.__TAURI__.dialog; // requires @tauri-apps/plugin-dialog
const { listen } = window.__TAURI__.event;

// Backend cancels superseded work (e.g. you kept typing, or opened a new
// file mid-scan) and returns this sentinel instead of a real error —
// treat it as "ignore, a newer request is already in flight," not a bug.
const isSuperseded = (e) => String(e).includes("SUPERSEDED");

listen("index-progress", (event) => {
  const pct = event.payload;
  el.openBtn.textContent = `Indexing… ${pct}%`;
});

// ---------- state ----------
const state = {
  rowCount: 0,
  rowHeight: 30,
  cache: new Map(),        // index -> preview object
  pendingFetch: null,      // in-flight window fetch, to avoid overlapping calls
  selectedIndex: null,
  matches: [],             // row indices from the last search
  currentMatchPos: -1,
  searchDebounce: null,
  selectedDupKeys: new Set(), // keys chosen in the dedupe-by-key picker
};

// ---------- DOM ----------
const el = {
  openBtn: document.getElementById("openBtn"),
  searchInput: document.getElementById("searchInput"),
  caseSensitive: document.getElementById("caseSensitive"),
  searchStatus: document.getElementById("searchStatus"),
  prevMatch: document.getElementById("prevMatch"),
  nextMatch: document.getElementById("nextMatch"),
  dupBtn: document.getElementById("dupBtn"),
  dupKeysWrap: document.getElementById("dupKeysWrap"),
  dupKeysBtn: document.getElementById("dupKeysBtn"),
  dupKeysPanel: document.getElementById("dupKeysPanel"),
  dupKeysList: document.getElementById("dupKeysList"),
  dupKeysManual: document.getElementById("dupKeysManual"),
  dupKeysClear: document.getElementById("dupKeysClear"),
  dupKeysDone: document.getElementById("dupKeysDone"),
  fileStats: document.getElementById("fileStats"),
  listViewport: document.getElementById("listViewport"),
  listSizer: document.getElementById("listSizer"),
  emptyState: document.getElementById("emptyState"),
  detailIndex: document.getElementById("detailIndex"),
  detailBody: document.getElementById("detailBody"),
  dupModal: document.getElementById("dupModal"),
  dupList: document.getElementById("dupList"),
  dupClose: document.getElementById("dupClose"),
  toast: document.getElementById("toast"),
};

// ---------- helpers ----------
function showToast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// ---------- open file ----------
el.openBtn.addEventListener("click", async () => {
  try {
    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json", "jsonl", "ndjson"] }],
    });
    if (!path) return;
    await loadFile(path);
  } catch (e) {
    showToast(`Could not open file: ${e}`, true);
  }
});

async function loadFile(path) {
  el.openBtn.disabled = true;
  el.openBtn.textContent = "Loading…";
  try {
    const summary = await invoke("load_file", { path });
    state.rowCount = summary.row_count;
    state.cache.clear();
    state.selectedIndex = null;
    state.matches = [];
    state.currentMatchPos = -1;

    el.fileStats.textContent = `${summary.row_count.toLocaleString()} rows · ${formatBytes(summary.file_size)} · ${summary.format}`;
    el.searchInput.disabled = false;
    el.dupBtn.disabled = false;
    el.dupKeysBtn.disabled = false;
    el.emptyState.classList.add("hidden");

    el.listSizer.style.height = `${state.rowCount * state.rowHeight}px`;
    renderVisibleWindow();
    el.detailIndex.textContent = "No row selected";
    el.detailBody.innerHTML = '<div class="hint">Select a row to inspect it here.</div>';
    showToast(`Loaded ${summary.row_count.toLocaleString()} rows`);

    state.selectedDupKeys.clear();
    updateDupKeysButtonLabel();
    populateDupKeysList();
  } catch (e) {
    if (!isSuperseded(e)) showToast(`${e}`, true);
  } finally {
    el.openBtn.disabled = false;
    el.openBtn.textContent = "Open File…";
  }
}

// ---------- virtualized list ----------
el.listViewport.addEventListener("scroll", () => renderVisibleWindow());
window.addEventListener("resize", () => renderVisibleWindow());

async function renderVisibleWindow() {
  if (state.rowCount === 0) return;

  const viewportH = el.listViewport.clientHeight;
  const scrollTop = el.listViewport.scrollTop;
  const rowH = state.rowHeight;

  const first = Math.max(0, Math.floor(scrollTop / rowH) - 8);   // small overscan
  const last = Math.min(state.rowCount, Math.ceil((scrollTop + viewportH) / rowH) + 8);

  // Figure out which rows in [first,last) we don't have cached yet.
  const missing = [];
  for (let i = first; i < last; i++) {
    if (!state.cache.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    const fetchOffset = missing[0];
    const fetchLimit = missing[missing.length - 1] - fetchOffset + 1;
    try {
      const rows = await invoke("get_rows", { offset: fetchOffset, limit: fetchLimit });
      for (const r of rows) state.cache.set(r.index, r);
    } catch (e) {
      // Loading a new file mid-flight etc — ignore stale errors.
    }
  }

  paintWindow(first, last);
}

function paintWindow(first, last) {
  const frag = document.createDocumentFragment();
  el.listSizer.querySelectorAll(".row-item").forEach((n) => n.remove());

  const matchSet = state.matches.length ? new Set(state.matches) : null;
  const currentMatchRow = state.currentMatchPos >= 0 ? state.matches[state.currentMatchPos] : null;

  for (let i = first; i < last; i++) {
    const data = state.cache.get(i);
    const div = document.createElement("div");
    div.className = "row-item";
    if (i === state.selectedIndex) div.classList.add("selected");
    if (matchSet && matchSet.has(i)) div.classList.add("match");
    if (i === currentMatchRow) div.classList.add("current-match");
    div.style.top = `${i * state.rowHeight}px`;
    div.dataset.index = String(i);

    const idxSpan = document.createElement("span");
    idxSpan.className = "row-index";
    idxSpan.textContent = i;

    const prevSpan = document.createElement("span");
    prevSpan.className = "row-preview";
    prevSpan.textContent = data ? data.preview : "…";

    div.appendChild(idxSpan);
    div.appendChild(prevSpan);
    div.addEventListener("click", () => selectRow(i));
    frag.appendChild(div);
  }
  el.listSizer.appendChild(frag);
}

// ---------- row selection / detail ----------
async function selectRow(index) {
  state.selectedIndex = index;
  paintWindow(
    Math.max(0, Math.floor(el.listViewport.scrollTop / state.rowHeight) - 8),
    Math.min(state.rowCount, Math.ceil((el.listViewport.scrollTop + el.listViewport.clientHeight) / state.rowHeight) + 8)
  );

  el.detailIndex.textContent = `Row ${index}`;
  el.detailBody.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const pretty = await invoke("get_row", { index });
    const parsed = JSON.parse(pretty);
    el.detailBody.innerHTML = "";
    el.detailBody.appendChild(renderJsonTree(parsed, true));
  } catch (e) {
    el.detailBody.innerHTML = `<div class="hint">Could not parse row: ${e}</div>`;
  }
}

function scrollToRow(index) {
  const target = index * state.rowHeight - el.listViewport.clientHeight / 2;
  el.listViewport.scrollTop = Math.max(0, target);
}

// ---------- JSON tree renderer ----------
function renderJsonTree(value, expanded) {
  const wrap = document.createElement("div");
  wrap.className = "jt-node";
  wrap.appendChild(renderValue(value, expanded, 0));
  return wrap;
}

function renderValue(value, expanded) {
  if (value === null) return leaf("null", "jt-lit");
  if (typeof value === "boolean") return leaf(String(value), "jt-lit");
  if (typeof value === "number") return leaf(String(value), "jt-number");
  if (typeof value === "string") return leaf(JSON.stringify(value), "jt-string");
  if (Array.isArray(value)) return renderContainer(value, "[", "]", expanded, value.map((v, i) => [String(i), v]));
  if (typeof value === "object") return renderContainer(value, "{", "}", expanded, Object.entries(value));
  return leaf(String(value), "jt-lit");
}

function leaf(text, cls) {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  return span;
}

function renderContainer(obj, openC, closeC, expanded, entries) {
  const container = document.createElement("div");
  container.className = "jt-node" + (expanded ? "" : " jt-collapsed");

  const row = document.createElement("div");
  row.className = "jt-row";

  const toggle = document.createElement("span");
  toggle.className = "jt-toggle";
  toggle.textContent = entries.length ? (expanded ? "▾" : "▸") : " ";
  if (entries.length) {
    toggle.addEventListener("click", () => {
      container.classList.toggle("jt-collapsed");
      toggle.textContent = container.classList.contains("jt-collapsed") ? "▸" : "▾";
    });
  }

  const open = document.createElement("span");
  open.className = "jt-punct";
  open.textContent = openC;

  const count = document.createElement("span");
  count.className = "jt-count";
  count.textContent = entries.length ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : "";

  row.appendChild(toggle);
  row.appendChild(open);
  if (!expanded || entries.length === 0) {
    const closeInline = document.createElement("span");
    closeInline.className = "jt-punct";
    closeInline.textContent = closeC;
    row.appendChild(count);
    row.appendChild(closeInline);
  } else {
    row.appendChild(count);
  }
  container.appendChild(row);

  if (entries.length) {
    const children = document.createElement("div");
    children.className = "jt-children";
    for (const [key, val] of entries) {
      const childRow = document.createElement("div");
      childRow.className = "jt-row";
      if (!Array.isArray(obj) || true) {
        // show keys for objects; array indices shown faintly
      }
      const keySpan = document.createElement("span");
      keySpan.className = Array.isArray(obj) ? "jt-count" : "jt-key";
      keySpan.textContent = Array.isArray(obj) ? `${key}: ` : `"${key}": `;
      childRow.appendChild(keySpan);
      childRow.appendChild(renderValue(val, false));
      children.appendChild(childRow);
    }
    const closeRow = document.createElement("div");
    closeRow.className = "jt-punct";
    closeRow.textContent = closeC;
    children.appendChild(closeRow);
    container.appendChild(children);
  }

  return container;
}

// ---------- search ----------
el.searchInput.addEventListener("input", () => {
  clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(runSearch, 180);
});
el.caseSensitive.addEventListener("change", runSearch);

async function runSearch() {
  const query = el.searchInput.value.trim();
  if (!query) {
    state.matches = [];
    state.currentMatchPos = -1;
    el.searchStatus.textContent = "";
    el.prevMatch.disabled = true;
    el.nextMatch.disabled = true;
    renderVisibleWindow();
    return;
  }
  try {
    const result = await invoke("search_rows", {
      query,
      caseSensitive: el.caseSensitive.checked,
    });
    state.matches = result.matches;
    state.currentMatchPos = result.matches.length ? 0 : -1;
    const suffix = result.truncated ? "+" : "";
    el.searchStatus.textContent = result.matches.length
      ? `${result.matches.length}${suffix} rows`
      : "no matches";
    el.prevMatch.disabled = el.nextMatch.disabled = result.matches.length === 0;
    if (result.matches.length) scrollToRow(result.matches[0]);
    renderVisibleWindow();
  } catch (e) {
    // A superseded search means a newer keystroke already fired another
    // search — its result is what the UI should show, so stay quiet here.
    if (!isSuperseded(e)) showToast(`Search failed: ${e}`, true);
  }
}

el.nextMatch.addEventListener("click", () => stepMatch(1));
el.prevMatch.addEventListener("click", () => stepMatch(-1));

function stepMatch(delta) {
  if (!state.matches.length) return;
  state.currentMatchPos = (state.currentMatchPos + delta + state.matches.length) % state.matches.length;
  const row = state.matches[state.currentMatchPos];
  scrollToRow(row);
  selectRow(row);
}

// ---------- duplicates ----------

// Populate the key picker from row 0's fields. Rows can vary in shape, so
// this is a best-effort sample, not a guaranteed-complete schema — the
// manual "add a key" field covers anything missing from row 0.
async function populateDupKeysList() {
  el.dupKeysList.innerHTML = '<div class="hint" style="padding:8px;">Loading keys…</div>';
  try {
    const result = await invoke("get_row_keys", { index: 0 });
    el.dupKeysList.innerHTML = "";
    if (result.parse_error) {
      el.dupKeysList.innerHTML = `<div class="hint" style="padding:8px;">Row 0 isn't valid JSON (${result.parse_error}) — type a key manually below.</div>`;
      return;
    }
    const keys = result.keys;
    if (!keys.length) {
      el.dupKeysList.innerHTML = '<div class="hint" style="padding:8px;">Row 0 has no object keys — type one manually below.</div>';
      return;
    }
    for (const key of keys) {
      const label = document.createElement("label");
      label.className = "dup-key-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = key;
      checkbox.checked = state.selectedDupKeys.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedDupKeys.add(key);
        else state.selectedDupKeys.delete(key);
        updateDupKeysButtonLabel();
      });
      const span = document.createElement("span");
      span.textContent = key;
      label.appendChild(checkbox);
      label.appendChild(span);
      el.dupKeysList.appendChild(label);
    }
  } catch (e) {
    console.error("get_row_keys failed:", e);
    if (!isSuperseded(e)) {
      el.dupKeysList.innerHTML = `<div class="hint" style="padding:8px;">Could not read row 0's keys: ${e}</div>`;
    }
  }
}

function updateDupKeysButtonLabel() {
  const n = state.selectedDupKeys.size;
  el.dupKeysBtn.textContent = n
    ? `Keys: ${n === 1 ? [...state.selectedDupKeys][0] : `${n} selected`} ▾`
    : "Keys: whole row ▾";
}

el.dupKeysBtn.addEventListener("click", () => {
  el.dupKeysPanel.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!el.dupKeysWrap.contains(e.target)) {
    el.dupKeysPanel.classList.add("hidden");
  }
});

el.dupKeysManual.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const key = el.dupKeysManual.value.trim();
  if (!key) return;
  state.selectedDupKeys.add(key);
  el.dupKeysManual.value = "";
  updateDupKeysButtonLabel();
  // Reflect it in the checklist too, in case it's actually one of row 0's
  // keys the user typed instead of clicked — avoids a duplicate entry.
  const existing = [...el.dupKeysList.querySelectorAll("input")].find((c) => c.value === key);
  if (existing) existing.checked = true;
});

el.dupKeysClear.addEventListener("click", () => {
  state.selectedDupKeys.clear();
  el.dupKeysManual.value = "";
  el.dupKeysList.querySelectorAll("input").forEach((c) => (c.checked = false));
  updateDupKeysButtonLabel();
});

el.dupKeysDone.addEventListener("click", () => {
  el.dupKeysPanel.classList.add("hidden");
});

el.dupBtn.addEventListener("click", async () => {
  const keys = [...state.selectedDupKeys];

  el.dupBtn.disabled = true;
  el.dupBtn.textContent = "Scanning…";
  try {
    const groups = await invoke("find_duplicates", { keys: keys.length ? keys : null });
    renderDupModal(groups, keys);
  } catch (e) {
    if (!isSuperseded(e)) showToast(`${e}`, true);
  } finally {
    el.dupBtn.disabled = false;
    el.dupBtn.textContent = "Find Duplicates";
  }
});

function renderDupModal(groups, keys = []) {
  el.dupList.innerHTML = "";
  const modeNote = document.createElement("div");
  modeNote.className = "hint";
  modeNote.style.padding = "8px 16px";
  modeNote.textContent = keys.length
    ? `Comparing by: ${keys.join(", ")}`
    : "Comparing whole row.";
  el.dupList.appendChild(modeNote);

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.style.padding = "16px";
    empty.textContent = "No duplicate rows found.";
    el.dupList.appendChild(empty);
  } else {
    for (const g of groups) {
      const item = document.createElement("div");
      item.className = "dup-group";
      const countBadge = document.createElement("span");
      countBadge.className = "dup-group-count";
      countBadge.textContent = `×${g.count}`;
      const idxSpan = document.createElement("span");
      idxSpan.className = "dup-group-indices";
      idxSpan.textContent = "rows " + g.row_indices.slice(0, 12).join(", ") + (g.row_indices.length > 12 ? "…" : "");
      item.appendChild(countBadge);
      item.appendChild(idxSpan);
      item.addEventListener("click", () => {
        closeDupModal();
        scrollToRow(g.row_indices[0]);
        selectRow(g.row_indices[0]);
      });
      el.dupList.appendChild(item);
    }
  }
  el.dupModal.classList.remove("hidden");
}

function closeDupModal() {
  el.dupModal.classList.add("hidden");
}
el.dupClose.addEventListener("click", closeDupModal);
el.dupModal.addEventListener("click", (e) => {
  if (e.target === el.dupModal) closeDupModal();
});

// ---------- keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    el.searchInput.focus();
  }
  if (e.key === "Enter" && document.activeElement === el.searchInput) {
    stepMatch(e.shiftKey ? -1 : 1);
  }
  if (e.key === "Escape") {
    closeDupModal();
    el.dupKeysPanel.classList.add("hidden");
  }
});
