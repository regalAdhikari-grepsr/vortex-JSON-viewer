// Appearance settings are initialized before the Tauri APIs so the controls
// also work in a plain browser preview.
const root = document.documentElement;
const settingsModal = document.getElementById("settingsModal");
const settingsTrigger = document.getElementById("themeToggle");
const settingsClose = document.getElementById("settingsClose");

function closeSettings() {
  settingsModal.classList.add("hidden");
  settingsTrigger.setAttribute("aria-expanded", "false");
  settingsTrigger.focus();
}

settingsTrigger.addEventListener("click", () => {
  settingsModal.classList.remove("hidden");
  settingsTrigger.setAttribute("aria-expanded", "true");
  settingsClose.focus();
});
settingsClose.addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsModal.classList.contains("hidden")) closeSettings();
});

function selectSetting(selector, attribute, value, storageKey, datasetKey) {
  root.dataset[datasetKey] = value;
  localStorage.setItem(storageKey, value);
  document.querySelectorAll(selector).forEach((button) => {
    const selected = button.getAttribute(attribute) === value;
    button.classList.toggle("active", selected);
    if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(selected));
  });
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => selectSetting(".mode-option", "data-mode", button.dataset.mode, "theme", "theme"));
});
document.querySelectorAll(".accent-option").forEach((button) => {
  button.addEventListener("click", () => selectSetting(".accent-option", "data-accent", button.dataset.accent, "accentTheme", "accent"));
});
document.querySelectorAll(".size-option").forEach((button) => {
  button.addEventListener("click", () => selectSetting(".size-option", "data-size", button.dataset.size, "fontSize", "fontSize"));
});
document.querySelectorAll(".font-option").forEach((button) => {
  button.addEventListener("click", () => selectSetting(".font-option", "data-font", button.dataset.font, "fontFamily", "fontFamily"));
});

selectSetting(".mode-option", "data-mode", root.dataset.theme, "theme", "theme");
selectSetting(".accent-option", "data-accent", root.dataset.accent, "accentTheme", "accent");
selectSetting(".size-option", "data-size", root.dataset.fontSize, "fontSize", "fontSize");
selectSetting(".font-option", "data-font", root.dataset.fontFamily, "fontFamily", "fontFamily");

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
  renderAgain: false,
  previewRenderTimer: null,
  selectedIndex: null,
  matches: [],             // row indices from the last search
  totalMatches: 0,
  searchActive: false,
  searchGeneration: 0,
  advancedSearchContext: null,
  currentMatchPos: -1,
  searchDebounce: null,
  keyboardNavPending: false,
  keyboardNavTimer: null,
  keyboardNavSequence: 0,
  selectedDupKeys: new Set(), // keys chosen in the dedupe-by-key picker
  duplicateMode: "whole",
  availableKeys: [],
  advancedSearchSelectedKeys: new Set(),
};

// ---------- DOM ----------
const el = {
  openBtn: document.getElementById("openBtn"),
  searchInput: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  advancedSearchIndicator: document.getElementById("advancedSearchIndicator"),
  caseSensitive: document.getElementById("caseSensitive"),
  searchStatus: document.getElementById("searchStatus"),
  prevMatch: document.getElementById("prevMatch"),
  nextMatch: document.getElementById("nextMatch"),
  advancedSearchBtn: document.getElementById("advancedSearchBtn"),
  advancedSearchModal: document.getElementById("advancedSearchModal"),
  advancedSearchClose: document.getElementById("advancedSearchClose"),
  advancedSearchCancel: document.getElementById("advancedSearchCancel"),
  advancedSearchRun: document.getElementById("advancedSearchRun"),
  advancedSearchQuery: document.getElementById("advancedSearchQuery"),
  advancedSearchCaseSensitive: document.getElementById("advancedSearchCaseSensitive"),
  advancedSearchRegex: document.getElementById("advancedSearchRegex"),
  advancedSearchKeys: document.getElementById("advancedSearchKeys"),
  advancedSearchKeyInput: document.getElementById("advancedSearchKeyInput"),
  advancedSearchAddKey: document.getElementById("advancedSearchAddKey"),
  advancedSearchSelectAll: document.getElementById("advancedSearchSelectAll"),
  dupBtn: document.getElementById("dupBtn"),
  dupKeysModal: document.getElementById("dupKeysModal"),
  dupKeysList: document.getElementById("dupKeysList"),
  dupKeysManual: document.getElementById("dupKeysManual"),
  dupKeysClear: document.getElementById("dupKeysClear"),
  dupKeyAdd: document.getElementById("dupKeyAdd"),
  dupKeysCancel: document.getElementById("dupKeysCancel"),
  dupKeysCancelBottom: document.getElementById("dupKeysCancelBottom"),
  dupKeysRun: document.getElementById("dupKeysRun"),
  dupWholeRow: document.getElementById("dupWholeRow"),
  dupByKeys: document.getElementById("dupByKeys"),
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

el.advancedSearchBtn.addEventListener("click", () => {
  el.advancedSearchModal.classList.remove("hidden");
  el.advancedSearchQuery.focus();
});
function closeAdvancedSearch() {
  el.advancedSearchModal.classList.add("hidden");
  el.advancedSearchBtn.focus();
}
el.advancedSearchClose.addEventListener("click", closeAdvancedSearch);
el.advancedSearchCancel.addEventListener("click", closeAdvancedSearch);
el.advancedSearchModal.addEventListener("click", (event) => {
  if (event.target === el.advancedSearchModal) closeAdvancedSearch();
});
el.advancedSearchSelectAll.addEventListener("click", () => {
  const boxes = [...el.advancedSearchKeys.querySelectorAll("input[type=checkbox]")];
  const select = boxes.some((box) => !box.checked);
  boxes.forEach((box) => {
    box.checked = select;
    if (select) state.advancedSearchSelectedKeys.add(box.value);
    else state.advancedSearchSelectedKeys.delete(box.value);
  });
  el.advancedSearchSelectAll.textContent = select ? "Clear selection" : "Select all";
});
el.advancedSearchAddKey.addEventListener("click", addAdvancedSearchKey);
el.advancedSearchKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addAdvancedSearchKey();
  }
});
el.advancedSearchQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runAdvancedSearch();
  }
});
el.advancedSearchRun.addEventListener("click", runAdvancedSearch);
el.clearSearch.addEventListener("click", clearSearch);

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
  cancelKeyboardNavigation();
  clearTimeout(state.searchDebounce);
  state.searchGeneration++;
  el.openBtn.disabled = true;
  el.openBtn.textContent = "Loading…";
  try {
    const summary = await invoke("load_file", { path });
    state.rowCount = summary.row_count;
    state.cache.clear();
    state.selectedIndex = null;
    state.matches = [];
    state.currentMatchPos = -1;
    state.totalMatches = 0;
    state.searchActive = false;
    clearAdvancedSearchIndicator();
    el.searchInput.value = "";
    el.advancedSearchQuery.value = "";
    el.searchStatus.textContent = "";
    el.prevMatch.disabled = true;
    el.nextMatch.disabled = true;

    el.fileStats.textContent = `${summary.row_count.toLocaleString()} rows · ${formatBytes(summary.file_size)} · ${summary.format}`;
    el.searchInput.disabled = false;
    el.dupBtn.disabled = false;
    el.advancedSearchBtn.disabled = false;
    updateClearSearchAvailability();
    el.emptyState.classList.add("hidden");

    el.listSizer.style.height = `${state.rowCount * state.rowHeight}px`;
    renderVisibleWindow();
    el.detailIndex.textContent = "No row selected";
    el.detailBody.innerHTML = '<div class="hint">Select a row to inspect it here.</div>';
    showToast(`Loaded ${summary.row_count.toLocaleString()} rows`);

    state.selectedDupKeys.clear();
    state.duplicateMode = "whole";
    el.dupWholeRow.checked = true;
    el.dupByKeys.checked = false;
    state.availableKeys = [];
    state.advancedSearchSelectedKeys.clear();
    populateDupKeysList();
  } catch (e) {
    if (!isSuperseded(e)) showToast(`${e}`, true);
  } finally {
    el.openBtn.disabled = false;
    el.openBtn.textContent = "Open File…";
  }
}

// ---------- virtualized list ----------
el.listViewport.addEventListener("scroll", () => {
  if (state.keyboardNavPending) {
    schedulePreviewRender();
    return;
  }
  renderVisibleWindow();
});
window.addEventListener("resize", () => renderVisibleWindow());

async function renderVisibleWindow() {
  if (state.rowCount === 0) return;

  if (state.pendingFetch) {
    state.renderAgain = true;
    return state.pendingFetch;
  }

  const fetchTask = (async () => {
    const viewportH = el.listViewport.clientHeight;
    const scrollTop = el.listViewport.scrollTop;
    const rowH = state.rowHeight;

    const first = Math.max(0, Math.floor(scrollTop / rowH) - 8);   // small overscan
    const last = Math.min(state.rowCount, Math.ceil((scrollTop + viewportH) / rowH) + 8);

    // Fetch only missing previews in the current visible window.
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
  })();
  state.pendingFetch = fetchTask;
  try {
    await fetchTask;
  } finally {
    state.pendingFetch = null;
    if (state.renderAgain) {
      state.renderAgain = false;
      await renderVisibleWindow();
    }
  }
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
    div.addEventListener("click", () => {
      cancelKeyboardNavigation();
      el.listViewport.focus({ preventScroll: true });
      selectRow(i);
    });
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
    if (state.selectedIndex !== index) return;
    const parsed = JSON.parse(pretty);
    el.detailBody.innerHTML = "";
    el.detailBody.appendChild(renderJsonTree(parsed, true));
  } catch (e) {
    if (state.selectedIndex !== index) return;
    el.detailBody.innerHTML = `<div class="hint">Could not parse row: ${e}</div>`;
  }
}

function navigateRow(delta) {
  if (state.rowCount === 0) return;
  const next = state.selectedIndex === null
    ? 0
    : Math.max(0, Math.min(state.rowCount - 1, state.selectedIndex + delta));
  state.selectedIndex = next;
  state.keyboardNavPending = true;
  const sequence = ++state.keyboardNavSequence;
  const rowTop = next * state.rowHeight;
  const rowBottom = rowTop + state.rowHeight;
  const viewTop = el.listViewport.scrollTop;
  const viewBottom = viewTop + el.listViewport.clientHeight;

  if (rowTop < viewTop) el.listViewport.scrollTop = rowTop;
  else if (rowBottom > viewBottom) el.listViewport.scrollTop = rowBottom - el.listViewport.clientHeight;
  const first = Math.max(0, Math.floor(el.listViewport.scrollTop / state.rowHeight) - 8);
  const last = Math.min(state.rowCount, Math.ceil((el.listViewport.scrollTop + el.listViewport.clientHeight) / state.rowHeight) + 8);
  paintWindow(first, last);
  schedulePreviewRender();
  el.detailIndex.textContent = `Row ${next}`;
  el.detailBody.innerHTML = '<div class="hint">Release the arrow key to load this row…</div>';
  clearTimeout(state.keyboardNavTimer);
  // Leave enough time for the platform's initial key-repeat delay; keyup
  // normally finishes immediately, while this covers lost keyup events.
  state.keyboardNavTimer = setTimeout(() => finishKeyboardNavigation(sequence), 500);
}

function schedulePreviewRender() {
  // Throttle rather than debounce: repeated key events should not postpone
  // visible preview loads until the key is released.
  if (state.previewRenderTimer !== null) return;
  state.previewRenderTimer = setTimeout(() => {
    state.previewRenderTimer = null;
    renderVisibleWindow();
  }, 40);
}

function cancelKeyboardNavigation() {
  clearTimeout(state.keyboardNavTimer);
  state.keyboardNavPending = false;
  state.keyboardNavSequence++;
}

async function finishKeyboardNavigation(sequence) {
  if (sequence !== state.keyboardNavSequence) return;
  clearTimeout(state.keyboardNavTimer);
  clearTimeout(state.previewRenderTimer);
  state.previewRenderTimer = null;
  state.keyboardNavPending = false;
  const selected = state.selectedIndex;
  await renderVisibleWindow();
  if (sequence === state.keyboardNavSequence && !state.keyboardNavPending && state.selectedIndex === selected) {
    selectRow(selected);
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
  const replacingAdvanced = Boolean(state.advancedSearchContext);
  clearAdvancedSearchIndicator();
  if (replacingAdvanced) {
    state.matches = [];
    state.totalMatches = 0;
    state.currentMatchPos = -1;
    el.searchStatus.textContent = "";
    el.prevMatch.disabled = true;
    el.nextMatch.disabled = true;
    renderVisibleWindow();
  }
  state.searchGeneration++;
  updateClearSearchAvailability();
  clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(runSearch, 180);
});
el.caseSensitive.addEventListener("change", () => {
  if (!state.advancedSearchContext) runSearch();
});

async function runSearch() {
  clearAdvancedSearchIndicator();
  const generation = ++state.searchGeneration;
  const query = el.searchInput.value.trim();
  if (!query) {
    state.searchActive = false;
    state.matches = [];
    state.totalMatches = 0;
    state.currentMatchPos = -1;
    el.searchStatus.textContent = "";
    el.prevMatch.disabled = true;
    el.nextMatch.disabled = true;
    updateClearSearchAvailability();
    if (!el.advancedSearchBtn.disabled) {
      invoke("search_rows", { query: "", caseSensitive: el.caseSensitive.checked }).catch(() => {});
    }
    renderVisibleWindow();
    return;
  }
  state.searchActive = true;
  updateClearSearchAvailability();
  try {
    const result = await invoke("search_rows", {
      query,
      caseSensitive: el.caseSensitive.checked,
    });
    if (generation !== state.searchGeneration) return;
    applySearchResult(result);
  } catch (e) {
    // A superseded search means a newer keystroke already fired another
    // search — its result is what the UI should show, so stay quiet here.
    if (generation === state.searchGeneration && !isSuperseded(e)) showToast(`Search failed: ${e}`, true);
  }
}

function updateClearSearchAvailability() {
  el.clearSearch.disabled = !state.searchActive && !el.searchInput.value.trim();
}

function setAdvancedSearchIndicator(keys, query) {
  state.advancedSearchContext = { keys, query };
  el.advancedSearchIndicator.textContent = keys.length === 1 ? keys[0] : `${keys.length} keys`;
  el.advancedSearchIndicator.title = `Searching ${keys.join(", ")} for: ${query}`;
  el.advancedSearchIndicator.hidden = false;
  el.advancedSearchBtn.classList.add("advanced-active");
}

function clearAdvancedSearchIndicator() {
  state.advancedSearchContext = null;
  el.advancedSearchIndicator.textContent = "";
  el.advancedSearchIndicator.title = "";
  el.advancedSearchIndicator.hidden = true;
  el.advancedSearchBtn.classList.remove("advanced-active");
}

function clearSearch() {
  clearTimeout(state.searchDebounce);
  state.searchGeneration++;
  state.searchActive = false;
  clearAdvancedSearchIndicator();
  el.searchInput.value = "";
  el.advancedSearchQuery.value = "";
  state.matches = [];
  state.totalMatches = 0;
  state.currentMatchPos = -1;
  el.searchStatus.textContent = "";
  el.prevMatch.disabled = true;
  el.nextMatch.disabled = true;
  updateClearSearchAvailability();
  if (!el.advancedSearchBtn.disabled) {
    invoke("search_rows", { query: "", caseSensitive: el.caseSensitive.checked }).catch(() => {});
  }
  renderVisibleWindow();
}

function applySearchResult(result) {
  state.searchActive = true;
  state.matches = result.matches;
  state.totalMatches = result.total_matches;
  state.currentMatchPos = result.matches.length ? 0 : -1;
  const count = result.total_matches.toLocaleString();
  const shown = result.truncated ? ` · showing first ${result.matches.length.toLocaleString()}` : "";
  el.searchStatus.textContent = `${count} rows${shown}`;
  updateClearSearchAvailability();
  el.prevMatch.disabled = el.nextMatch.disabled = result.matches.length === 0;
  if (result.matches.length) scrollToRow(result.matches[0]);
  renderVisibleWindow();
}

async function runAdvancedSearch() {
  const query = el.advancedSearchQuery.value;
  const keys = [...el.advancedSearchKeys.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
  if (!query.trim()) {
    showToast("Enter a value or regular expression to search for", true);
    el.advancedSearchQuery.focus();
    return;
  }
  if (!keys.length) {
    showToast("Select or add at least one key to search", true);
    return;
  }

  el.advancedSearchRun.disabled = true;
  el.advancedSearchRun.textContent = "Searching…";
  clearTimeout(state.searchDebounce);
  const generation = ++state.searchGeneration;
  try {
    const result = await invoke("advanced_search_rows", {
      query,
      keys,
      caseSensitive: el.advancedSearchCaseSensitive.checked,
      regexMode: el.advancedSearchRegex.checked,
    });
    if (generation !== state.searchGeneration) return;
    el.searchInput.value = "";
    applySearchResult(result);
    setAdvancedSearchIndicator(keys, query);
    closeAdvancedSearch();
    if (state.matches.length) el.nextMatch.focus();
  } catch (e) {
    if (generation === state.searchGeneration && !isSuperseded(e)) showToast(`Search failed: ${e}`, true);
  } finally {
    el.advancedSearchRun.disabled = false;
    el.advancedSearchRun.textContent = "Search";
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

function populateAdvancedSearchKeys(keys) {
  el.advancedSearchKeys.innerHTML = "";
  el.advancedSearchSelectAll.textContent = "Select all";
  if (!keys.length) {
    el.advancedSearchKeys.innerHTML = '<div class="hint" style="padding:8px;">No keys found in row 0. You can add a key path below.</div>';
    return;
  }
  for (const key of keys) {
    const label = document.createElement("label");
    label.className = "advanced-search-key-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = key;
    checkbox.checked = state.advancedSearchSelectedKeys.has(key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.advancedSearchSelectedKeys.add(key);
      else state.advancedSearchSelectedKeys.delete(key);
      const allSelected = keys.length > 0 && keys.every((candidate) => state.advancedSearchSelectedKeys.has(candidate));
      el.advancedSearchSelectAll.textContent = allSelected ? "Clear selection" : "Select all";
    });
    const text = document.createElement("span");
    text.textContent = key;
    label.append(checkbox, text);
    el.advancedSearchKeys.appendChild(label);
  }
  el.advancedSearchSelectAll.textContent = keys.every((key) => state.advancedSearchSelectedKeys.has(key))
    ? "Clear selection"
    : "Select all";
}

function addAdvancedSearchKey() {
  const key = el.advancedSearchKeyInput.value.trim();
  if (!key) return;
  if (!state.availableKeys.includes(key)) state.availableKeys.push(key);
  state.advancedSearchSelectedKeys.add(key);
  populateAdvancedSearchKeys(state.availableKeys);
  el.advancedSearchKeyInput.value = "";
  const added = [...el.advancedSearchKeys.querySelectorAll("input")].find((box) => box.value === key);
  if (added) added.focus();
}

// Populate the key picker from row 0's fields. Rows can vary in shape, so
// this is a best-effort sample, not a guaranteed-complete schema — the
// manual "add a key" field covers anything missing from row 0.
async function populateDupKeysList() {
  el.dupKeysList.innerHTML = '<div class="hint" style="padding:8px;">Loading keys…</div>';
  el.advancedSearchKeys.innerHTML = '<div class="hint" style="padding:8px;">Loading keys…</div>';
  try {
    const result = await invoke("get_row_keys", { index: 0 });
    el.dupKeysList.innerHTML = "";
    state.availableKeys = result.keys;
    populateAdvancedSearchKeys(state.availableKeys);
    if (result.parse_error) {
      el.dupKeysList.innerHTML = `<div class="hint" style="padding:8px;">Row 0 isn't valid JSON (${result.parse_error}) — type a key manually below.</div>`;
      return;
    }
    const keys = result.keys;
    if (!keys.length) {
      el.dupKeysList.innerHTML = '<div class="hint" style="padding:8px;">Row 0 has no object keys — type one manually below.</div>';
      return;
    }
    for (const key of keys) renderDuplicateKeyOption(key, state.selectedDupKeys.has(key));
  } catch (e) {
    console.error("get_row_keys failed:", e);
    state.availableKeys = [];
    populateAdvancedSearchKeys(state.availableKeys);
    if (!isSuperseded(e)) {
      el.dupKeysList.innerHTML = `<div class="hint" style="padding:8px;">Could not read row 0's keys: ${e}</div>`;
    }
  }
}

function renderDuplicateKeyOption(key, selected = false) {
  const label = document.createElement("label");
  label.className = "dup-key-option";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = key;
  checkbox.checked = selected;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      state.selectedDupKeys.add(key);
      state.duplicateMode = "keys";
      el.dupByKeys.checked = true;
    } else {
      state.selectedDupKeys.delete(key);
    }
  });
  const span = document.createElement("span");
  span.textContent = key;
  label.append(checkbox, span);
  el.dupKeysList.appendChild(label);
}

function closeDupKeysModal() {
  el.dupKeysModal.classList.add("hidden");
  el.dupBtn.focus();
}

el.dupBtn.addEventListener("click", () => {
  el.dupWholeRow.checked = state.duplicateMode === "whole";
  el.dupByKeys.checked = state.duplicateMode === "keys";
  el.dupKeysModal.classList.remove("hidden");
  el.dupKeysRun.focus();
});
el.dupWholeRow.addEventListener("change", () => {
  if (el.dupWholeRow.checked) state.duplicateMode = "whole";
});
el.dupByKeys.addEventListener("change", () => {
  if (el.dupByKeys.checked) state.duplicateMode = "keys";
});
el.dupKeysCancel.addEventListener("click", closeDupKeysModal);
el.dupKeysCancelBottom.addEventListener("click", closeDupKeysModal);
el.dupKeysModal.addEventListener("click", (event) => {
  if (event.target === el.dupKeysModal) closeDupKeysModal();
});

function addDuplicateKey() {
  const key = el.dupKeysManual.value.trim();
  if (!key) return;
  state.selectedDupKeys.add(key);
  state.duplicateMode = "keys";
  el.dupByKeys.checked = true;
  if (!state.availableKeys.includes(key)) {
    state.availableKeys.push(key);
    populateAdvancedSearchKeys(state.availableKeys);
  }
  el.dupKeysManual.value = "";
  const existing = [...el.dupKeysList.querySelectorAll("input")].find((checkbox) => checkbox.value === key);
  if (existing) existing.checked = true;
  else renderDuplicateKeyOption(key, true);
}
el.dupKeyAdd.addEventListener("click", addDuplicateKey);
el.dupKeysManual.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addDuplicateKey();
  }
});

el.dupKeysClear.addEventListener("click", () => {
  state.selectedDupKeys.clear();
  el.dupKeysManual.value = "";
  el.dupKeysList.querySelectorAll("input").forEach((c) => (c.checked = false));
  state.duplicateMode = "whole";
  el.dupWholeRow.checked = true;
  el.dupByKeys.checked = false;
});

async function runDuplicateSearch() {
  const keys = state.duplicateMode === "keys" ? [...state.selectedDupKeys] : [];
  if (state.duplicateMode === "keys" && !keys.length) {
    showToast("Select or add at least one key", true);
    return;
  }

  el.dupBtn.disabled = true;
  el.dupBtn.textContent = "Scanning…";
  el.dupKeysRun.disabled = true;
  el.dupKeysRun.textContent = "Scanning…";
  closeDupKeysModal();
  try {
    const groups = await invoke("find_duplicates", { keys: keys.length ? keys : null });
    renderDupModal(groups, keys);
  } catch (e) {
    if (!isSuperseded(e)) showToast(`${e}`, true);
  } finally {
    el.dupBtn.disabled = false;
    el.dupBtn.textContent = "Find Duplicates";
    el.dupKeysRun.disabled = false;
    el.dupKeysRun.textContent = "Find Duplicates";
  }
}
el.dupKeysRun.addEventListener("click", runDuplicateSearch);

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
  const target = e.target;
  const isEditing = target instanceof HTMLElement && (
    target.isContentEditable || target.matches("input, textarea, select")
  );
  const overlayOpen = !settingsModal.classList.contains("hidden")
    || !el.advancedSearchModal.classList.contains("hidden")
    || !el.dupModal.classList.contains("hidden")
    || !el.dupKeysModal.classList.contains("hidden");

  if (!isEditing && !overlayOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    navigateRow(e.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    el.searchInput.focus();
  }
  if (e.key === "Enter" && document.activeElement === el.searchInput) {
    stepMatch(e.shiftKey ? -1 : 1);
  }
  if (e.key === "Escape") {
    if (!el.advancedSearchModal.classList.contains("hidden")) closeAdvancedSearch();
    if (!el.dupKeysModal.classList.contains("hidden")) closeDupKeysModal();
    closeDupModal();
  }
});

document.addEventListener("keyup", (e) => {
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && state.keyboardNavPending) {
    clearTimeout(state.keyboardNavTimer);
    finishKeyboardNavigation(state.keyboardNavSequence);
  }
});
