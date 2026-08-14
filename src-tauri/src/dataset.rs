//! Memory-mapped JSON / JSON-Lines dataset engine.
//!
//! Design goal: never parse the *whole* file into a tree of serde_json::Value.
//! Instead we memory-map the file once and build a lightweight index of
//! byte offsets — one (start, end) pair per "row". Parsing only happens
//! lazily, for the handful of rows currently visible on screen, or for
//! rows a search actually matched.
//!
//! This is what makes multi-GB files usable: indexing is a single linear
//! byte scan (fast, SIMD-accelerated via `memchr`), and everything after
//! that (scrolling, searching, dedup) works off that index.

use memchr::memmem;
use memmap2::Mmap;
use once_cell::sync::OnceCell;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    JsonLines,
    JsonArray,
    /// A single top-level JSON object/value that isn't an array of rows.
    /// We treat the whole file as "row 0" and just render it as a tree.
    JsonSingle,
}

pub struct Dataset {
    mmap: Mmap,
    /// (start, end) byte ranges into `mmap`, one per row, already trimmed
    /// of surrounding whitespace/newlines.
    offsets: Vec<(usize, usize)>,
    pub format: Format,
    pub file_size: u64,
    /// Lowercased copy of the whole file, built lazily on the FIRST
    /// case-insensitive search and cached for every search after that.
    /// Before this existed, every case-insensitive search rebuilt this
    /// from scratch (a full-file allocation + copy on every keystroke) —
    /// that was the main cause of search freezes on large files.
    lower_cache: OnceCell<Vec<u8>>,
}

/// Called periodically during expensive operations. Returning `true` means
/// "a newer operation has superseded this one, stop now." Backed by a
/// single counter in AppState that's bumped on every new load/search, so
/// stale work gets abandoned instead of piling up and fighting for CPU.
pub trait Cancel: Fn() -> bool + Sync {}
impl<T: Fn() -> bool + Sync> Cancel for T {}

/// Called periodically during indexing with a 0..=100 percent estimate,
/// so the frontend can show real progress instead of a frozen button.
pub trait Progress: Fn(u8) + Sync {}
impl<T: Fn(u8) + Sync> Progress for T {}

#[derive(Serialize)]
pub struct LoadSummary {
    pub row_count: usize,
    pub format: Format,
    pub file_size: u64,
}

#[derive(Serialize)]
pub struct RowPreview {
    pub index: usize,
    /// First ~300 chars, single line, for the virtualized list.
    pub preview: String,
    pub byte_len: usize,
}

#[derive(Serialize)]
pub struct RowKeys {
    pub keys: Vec<String>,
    /// Set when the row exists but isn't valid JSON, so the UI can show
    /// a specific reason instead of a generic "something went wrong."
    pub parse_error: Option<String>,
}

impl Dataset {
    /// Blocking — the caller (a Tauri command) is expected to run this
    /// inside `spawn_blocking` so it doesn't tie up the async executor.
    pub fn load(
        path: &str,
        on_progress: &(impl Progress + ?Sized),
        cancelled: &(impl Cancel + ?Sized),
    ) -> io::Result<Option<Self>> {
        let file = File::open(path)?;
        let file_size = file.metadata()?.len();
        // SAFETY: standard mmap caveat — the file must not be mutated by
        // another process while mapped. Fine for a read-only viewer tool.
        let mmap = unsafe { Mmap::map(&file)? };

        // Sniff format from the first non-whitespace byte.
        let first_byte = mmap.iter().find(|b| !b.is_ascii_whitespace()).copied();

        let indexed = match first_byte {
            Some(b'[') => {
                index_json_array(&mmap, on_progress, cancelled).map(|o| (o, Format::JsonArray))
            }
            Some(b'{') => {
                // Ambiguous: could be one big object, or JSONL where the
                // first line happens to be an object (the common case).
                // Heuristic: if there's more than one non-empty line,
                // treat it as JSONL. Otherwise treat as a single object.
                index_json_lines(&mmap, on_progress, cancelled).and_then(|o| {
                    if o.len() > 1 {
                        Some((o, Format::JsonLines))
                    } else {
                        Some((vec![(0usize, mmap.len())], Format::JsonSingle))
                    }
                })
            }
            _ => Some((vec![(0usize, mmap.len())], Format::JsonSingle)),
        };

        let Some((offsets, format)) = indexed else {
            return Ok(None); // cancelled mid-index
        };

        Ok(Some(Dataset {
            mmap,
            offsets,
            format,
            file_size,
            lower_cache: OnceCell::new(),
        }))
    }

    pub fn summary(&self) -> LoadSummary {
        LoadSummary {
            row_count: self.offsets.len(),
            format: self.format,
            file_size: self.file_size,
        }
    }

    pub fn row_count(&self) -> usize {
        self.offsets.len()
    }

    fn row_bytes(&self, index: usize) -> Option<&[u8]> {
        self.offsets
            .get(index)
            .map(|&(s, e)| &self.mmap[s..e])
    }

    /// Lazily parse + pretty-print a single row. Only called for rows the
    /// user actually opens, so cost is O(1 row), not O(file).
    pub fn get_row_pretty(&self, index: usize) -> Option<Result<String, String>> {
        let bytes = self.row_bytes(index)?;
        Some(
            serde_json::from_slice::<serde_json::Value>(bytes)
                .map_err(|e| e.to_string())
                .and_then(|v| serde_json::to_string_pretty(&v).map_err(|e| e.to_string())),
        )
    }

    /// Collect key paths present in a row's JSON, for populating the
    /// "dedupe by keys" picker in the UI. Nested object fields are
    /// returned as dot paths (e.g. `"user.email"`); arrays are sampled via
    /// their first element (e.g. `"items.0.sku"`). Stops at `max_depth` so
    /// pathological schemas don't produce huge lists.
    ///
    /// Returns `None` only if `index` is out of range. If the row exists
    /// but fails to parse as JSON, that's reported via `parse_error`
    /// rather than collapsed into an empty key list — the UI needs to be
    /// able to tell "this row has no keys" apart from "this row is
    /// broken," since they call for different messages.
    pub fn row_key_paths(&self, index: usize, max_depth: usize) -> Option<RowKeys> {
        let bytes = self.row_bytes(index)?;
        Some(match serde_json::from_slice::<serde_json::Value>(bytes) {
            Ok(value) => {
                let mut paths = Vec::new();
                collect_key_paths(&value, String::new(), 0, max_depth, &mut paths);
                RowKeys { keys: paths, parse_error: None }
            }
            Err(e) => RowKeys { keys: Vec::new(), parse_error: Some(e.to_string()) },
        })
    }

    /// Cheap previews for a window of rows (what the virtual list renders).
    /// Does NOT fully parse+pretty-print — just trims/truncates raw bytes,
    /// which is enough for a single-line list preview and much cheaper.
    pub fn get_row_previews(&self, offset: usize, limit: usize) -> Vec<RowPreview> {
        let end = (offset + limit).min(self.offsets.len());
        if offset >= end {
            return Vec::new();
        }
        (offset..end)
            .map(|i| {
                let bytes = self.row_bytes(i).unwrap_or(b"");
                let raw = String::from_utf8_lossy(bytes);
                let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
                let preview: String = collapsed.chars().take(300).collect();
                RowPreview {
                    index: i,
                    preview,
                    byte_len: bytes.len(),
                }
            })
            .collect()
    }

    /// Ultra-fast substring search across the *entire raw file* using
    /// memchr's SIMD substring search, then maps each byte hit back to its
    /// row via binary search over the offsets table. No per-search index
    /// build needed — it's a linear scan, which runs at multiple GB/s.
    ///
    /// `cancelled` is polled periodically; if it flips true (a newer
    /// search or file load has superseded this one) we stop scanning
    /// immediately instead of burning CPU on a result nobody will see.
    pub fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        limit: usize,
        cancelled: &(impl Cancel + ?Sized),
    ) -> Option<SearchResult> {
        if query.is_empty() {
            return Some(SearchResult {
                matches: Vec::new(),
                total_matches: 0,
                truncated: false,
            });
        }

        // We're searching the *raw, undecoded* JSON bytes on disk (that's
        // what makes this fast — no per-row parsing). But some JSON
        // encoders escape '/' as '\/' in string values (PHP's json_encode
        // does this by default, as do some Java/JS libraries), even
        // though the JSON spec doesn't require it. That means a value
        // like "https://example.com" can be sitting in the file as
        // `https:\/\/example.com`, and a literal search for the
        // unescaped query would never find it — and vice versa if the
        // user pastes an already-escaped string. So we search for every
        // plausible on-disk encoding of the query and merge the row
        // hits, rather than assuming the query's slashes match the
        // file's slashes verbatim.
        let variants = build_query_variants(query);

        // Pick which buffer to scan. For case-insensitive search we build
        // the lowercased copy of the file exactly ONCE per dataset (in
        // parallel across cores) and cache it — every search after the
        // first reuses it for free instead of re-lowering the whole file.
        let haystack: &[u8] = if case_sensitive {
            &self.mmap[..]
        } else {
            self.lower_cache
                .get_or_init(|| self.mmap.par_iter().map(|b| b.to_ascii_lowercase()).collect())
        };

        let mut matched_rows: Vec<usize> = Vec::new();
        let mut seen_rows: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut total = 0usize;
        let mut scanned = 0u32;

        for variant in &variants {
            let variant_owned;
            let needle: &[u8] = if case_sensitive {
                variant.as_bytes()
            } else {
                variant_owned = variant.to_lowercase();
                variant_owned.as_bytes()
            };
            if needle.is_empty() {
                continue;
            }

            let finder = memmem::Finder::new(needle);
            for pos in finder.find_iter(haystack) {
                scanned += 1;
                if scanned % 2048 == 0 && cancelled() {
                    return None;
                }
                total += 1;
                if let Some(row) = self.row_for_offset(pos) {
                    if seen_rows.insert(row) {
                        matched_rows.push(row);
                    }
                }
            }
        }

        // Merging multiple variant scans can produce rows out of order
        // (variant 2's hits aren't interleaved with variant 1's), so
        // restore ascending order for sane "jump to next match" behavior.
        matched_rows.sort_unstable();

        let truncated = matched_rows.len() > limit;
        matched_rows.truncate(limit);

        Some(SearchResult {
            matches: matched_rows,
            total_matches: total,
            truncated,
        })
    }

    /// Find duplicate rows by comparing only specific keys instead of the
    /// whole row. `keys` supports dot-paths for nested fields (e.g.
    /// `"user.id"`). A row missing a key is treated as JSON `null` for
    /// that key, so "all rows missing this field" still groups together
    /// as a duplicate set rather than being silently dropped. Rows that
    /// fail to parse as JSON are excluded (nothing meaningful to compare).
    ///
    /// Unlike `find_duplicates`, this has to actually parse every row
    /// (can't hash raw bytes when we only care about a subset of fields),
    /// so it's O(rows) parses rather than a pure byte scan — still
    /// parallelized across cores, but expect it to be slower on very
    /// large files.
    pub fn find_duplicates_by_keys(
        &self,
        keys: &[String],
        cancelled: &(impl Cancel + ?Sized),
    ) -> Option<Vec<DuplicateGroup>> {
        if keys.is_empty() {
            return self.find_duplicates(cancelled);
        }
        if cancelled() {
            return None;
        }

        let n = self.offsets.len();
        let composite: Vec<Option<String>> = (0..n)
            .into_par_iter()
            .map(|i| {
                let bytes = self.row_bytes(i)?;
                let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
                let parts: Vec<serde_json::Value> = keys
                    .iter()
                    .map(|k| lookup_path(&value, k).cloned().unwrap_or(serde_json::Value::Null))
                    .collect();
                serde_json::to_string(&parts).ok()
            })
            .collect();

        if cancelled() {
            return None;
        }

        let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, key) in composite.into_iter().enumerate() {
            if let Some(k) = key {
                groups.entry(k).or_default().push(i);
            }
        }

        let mut result: Vec<DuplicateGroup> = groups
            .into_iter()
            .filter(|(_, idxs)| idxs.len() > 1)
            .map(|(_, idxs)| DuplicateGroup {
                count: idxs.len(),
                row_indices: idxs,
            })
            .collect();
        result.sort_by(|a, b| b.count.cmp(&a.count));
        Some(result)
    }

    fn row_for_offset(&self, pos: usize) -> Option<usize> {
        // Binary search over sorted, non-overlapping offset ranges.
        match self
            .offsets
            .binary_search_by(|&(s, e)| {
                if pos < s {
                    std::cmp::Ordering::Greater
                } else if pos >= e {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            }) {
            Ok(i) => Some(i),
            Err(_) => None,
        }
    }

    /// Groups rows that are byte-for-byte identical (after whitespace
    /// trimming) once whitespace-normalized. Runs the hashing in parallel
    /// across all cores via rayon, then verifies each collision group with
    /// a real byte comparison to rule out hash collisions.
    pub fn find_duplicates(&self, cancelled: &(impl Cancel + ?Sized)) -> Option<Vec<DuplicateGroup>> {
        if cancelled() {
            return None;
        }
        let hashes: Vec<u64> = self
            .offsets
            .par_iter()
            .map(|&(s, e)| fxhash_normalized(&self.mmap[s..e]))
            .collect();

        let mut groups: HashMap<u64, Vec<usize>> = HashMap::new();
        for (i, h) in hashes.into_iter().enumerate() {
            groups.entry(h).or_default().push(i);
        }

        let mut result = Vec::new();
        for (_, indices) in groups {
            if indices.len() < 2 {
                continue;
            }
            // Verify: split any accidental hash collisions apart by
            // actually comparing normalized bytes.
            let mut verified: HashMap<Vec<u8>, Vec<usize>> = HashMap::new();
            for &i in &indices {
                let norm = normalized_bytes(self.row_bytes(i).unwrap_or(b""));
                verified.entry(norm).or_default().push(i);
            }
            for (_, idxs) in verified {
                if idxs.len() > 1 {
                    result.push(DuplicateGroup {
                        count: idxs.len(),
                        row_indices: idxs,
                    });
                }
            }
        }
        result.sort_by(|a, b| b.count.cmp(&a.count));
        Some(result)
    }
}

#[derive(Serialize)]
pub struct SearchResult {
    pub matches: Vec<usize>,
    pub total_matches: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct DuplicateGroup {
    pub row_indices: Vec<usize>,
    pub count: usize,
}

/// Strip all whitespace outside of strings so `{"a": 1}` and `{"a":1}` hash
/// the same. Cheap, byte-level, no JSON parsing required.
fn normalized_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut escape = false;
    for &b in bytes {
        if in_string {
            out.push(b);
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
            out.push(b);
        } else if !b.is_ascii_whitespace() {
            out.push(b);
        }
    }
    out
}

fn fxhash_normalized(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let norm = normalized_bytes(bytes);
    let mut hasher = fxhash::FxHasher::default();
    norm.hash(&mut hasher);
    hasher.finish()
}

/// Index a JSON-Lines file: one row per non-empty line.
///
/// Parallelized across CPU cores: raw `\n` bytes can never legally appear
/// inside a JSON string (the spec requires them escaped as `\n`), so
/// finding newline positions is embarrassingly parallel — we can split the
/// file into arbitrary chunks (no need to align to line boundaries) and
/// have each core scan its chunk independently, then flatten the results
/// back together in order.
fn index_json_lines(
    mmap: &Mmap,
    on_progress: &(impl Progress + ?Sized),
    cancelled: &(impl Cancel + ?Sized),
) -> Option<Vec<(usize, usize)>> {
    let len = mmap.len();
    if len == 0 {
        return Some(Vec::new());
    }

    let num_chunks = (rayon::current_num_threads() * 4).max(1);
    let chunk_size = (len / num_chunks).max(1 << 20); // at least 1MB per chunk
    let completed = AtomicUsize::new(0);
    let total_chunks = len.div_ceil(chunk_size).max(1);
    let last_reported = AtomicUsize::new(0);
    let bail = std::sync::atomic::AtomicBool::new(false);

    let per_chunk_positions: Vec<Vec<usize>> = mmap
        .par_chunks(chunk_size)
        .enumerate()
        .map(|(chunk_idx, chunk)| {
            if bail.load(Ordering::Relaxed) || cancelled() {
                bail.store(true, Ordering::Relaxed);
                return Vec::new();
            }
            let base = chunk_idx * chunk_size;
            let positions: Vec<usize> = memchr::memchr_iter(b'\n', chunk).map(|p| p + base).collect();

            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            let pct = ((done * 100) / total_chunks) as usize;
            if pct >= last_reported.load(Ordering::Relaxed) + 5 {
                last_reported.store(pct, Ordering::Relaxed);
                on_progress(pct.min(99) as u8);
            }
            positions
        })
        .collect();

    if bail.load(Ordering::Relaxed) {
        return None;
    }

    let mut offsets = Vec::new();
    let mut start = 0usize;
    for pos in per_chunk_positions.into_iter().flatten() {
        let (s, e) = trim_range(mmap, start, pos);
        if e > s {
            offsets.push((s, e));
        }
        start = pos + 1;
    }
    if start < len {
        let (s, e) = trim_range(mmap, start, len);
        if e > s {
            offsets.push((s, e));
        }
    }
    on_progress(100);
    Some(offsets)
}

/// Index a top-level JSON array: `[ {...}, {...}, 123, "x", ... ]`.
///
/// This is a lightweight hand-rolled scanner, NOT a full JSON validator.
/// It assumes well-formed input and tracks just enough state (string vs
/// not, and object/array nesting depth) to find where each top-level
/// element starts and ends. Works for arrays of objects/arrays (the
/// common "massive JSON" shape) as well as arrays of bare scalars.
///
/// This can't be parallelized as cleanly as the JSONL scanner (nesting
/// depth is inherently sequential state), but the dominant cost for
/// typical product/catalog JSON is scanning through long string values
/// (descriptions, URLs, etc.) — so instead of inspecting every byte one
/// at a time while inside a string, we jump straight to the next quote
/// or backslash with `memchr::memchr2` (SIMD-accelerated). That skips
/// over the bulk of the file's bytes rather than branching on each one.
fn index_json_array(
    mmap: &Mmap,
    on_progress: &(impl Progress + ?Sized),
    cancelled: &(impl Cancel + ?Sized),
) -> Option<Vec<(usize, usize)>> {
    let bytes: &[u8] = mmap;
    let mut offsets = Vec::new();

    // Find the opening '[' of the top-level array.
    let Some(array_start) = bytes.iter().position(|&b| b == b'[') else {
        return Some(offsets);
    };

    let mut i = array_start + 1;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut elem_start: Option<usize> = None;
    let mut last_reported = 0u8;
    let mut since_check = 0u32;

    while i < bytes.len() {
        since_check += 1;
        if since_check >= 200_000 {
            since_check = 0;
            if cancelled() {
                return None;
            }
            let pct = ((i * 100) / bytes.len().max(1)) as u8;
            if pct >= last_reported + 5 {
                last_reported = pct;
                on_progress(pct.min(99));
            }
        }

        if in_string {
            // Fast-skip straight to the next quote or backslash instead
            // of branching on every byte of the string's contents.
            match memchr::memchr2(b'"', b'\\', &bytes[i..]) {
                Some(rel) => {
                    i += rel;
                    if bytes[i] == b'\\' {
                        i += 2; // skip the escape pair (\", \\, \n, \uXXXX's leading \u, etc.)
                    } else {
                        in_string = false;
                        i += 1;
                    }
                }
                None => break, // malformed / unterminated string at EOF
            }
            continue;
        }

        let b = bytes[i];
        match b {
            b'"' => {
                if elem_start.is_none() {
                    elem_start = Some(i);
                }
                in_string = true;
            }
            b'{' | b'[' => {
                if elem_start.is_none() {
                    elem_start = Some(i);
                }
                depth += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s) = elem_start.take() {
                        offsets.push((s, i + 1));
                    } else {
                        // depth hit 0 with no element open: this is the
                        // outer array's closing ']'.
                        break;
                    }
                } else if depth < 0 {
                    // Closing bracket of the outer array with no open
                    // element (e.g. trailing comma edge case) — done.
                    break;
                }
            }
            b',' if depth == 0 => {
                // Bare scalar element (number/bool/null) ending here.
                if let Some(s) = elem_start.take() {
                    let (s2, e2) = trim_range(mmap, s, i);
                    if e2 > s2 {
                        offsets.push((s2, e2));
                    }
                }
            }
            _ => {
                if depth == 0 && !b.is_ascii_whitespace() && elem_start.is_none() {
                    elem_start = Some(i);
                }
            }
        }
        i += 1;
    }

    // Trailing bare scalar right before the final ']' with no comma.
    if let Some(s) = elem_start {
        let (s2, e2) = trim_range(mmap, s, bytes.len());
        if e2 > s2 {
            offsets.push((s2, e2));
        }
    }

    on_progress(100);
    Some(offsets)
}

/// Given a user's search query, produce every plausible on-disk encoding
/// worth searching for. Currently just handles the '/' vs '\/' JSON
/// escaping ambiguity (see comment at the call site) — symmetric in both
/// directions so it doesn't matter whether the user types the escaped or
/// unescaped form.
fn build_query_variants(query: &str) -> Vec<String> {
    let mut variants = vec![query.to_string()];

    if query.contains('/') {
        variants.push(query.replace('/', "\\/"));
    }
    if query.contains("\\/") {
        variants.push(query.replace("\\/", "/"));
    }

    variants.sort();
    variants.dedup();
    variants
}

/// Recursively collect dot-path key names from a JSON object, for the
/// dedupe key picker. Both intermediate keys and leaf keys are included,
/// since either can be a meaningful thing to dedupe on (a whole nested
/// object, or a specific scalar field inside it). Arrays are sampled via
/// their first element (`"items.0.sku"`) rather than expanded per-index —
/// a dedupe key is almost always about a field shared across elements,
/// not one specific array position, and expanding every index would blow
/// up the picker on any row with a long array.
fn collect_key_paths(
    value: &serde_json::Value,
    prefix: String,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let path = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                out.push(path.clone());
                if depth + 1 < max_depth {
                    collect_key_paths(v, path, depth + 1, max_depth, out);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            if prefix.is_empty() {
                return; // don't emit a leading-dot path for a bare top-level array row
            }
            if let Some(first) = arr.first() {
                let path = format!("{prefix}.0");
                out.push(path.clone());
                if depth + 1 < max_depth {
                    collect_key_paths(first, path, depth + 1, max_depth, out);
                }
            }
        }
        _ => {}
    }
}

/// Dot-path lookup into a parsed JSON value, e.g. `"user.id"` ->
/// `value["user"]["id"]`, or `"items.0.sku"` -> `value["items"][0]["sku"]`.
/// Returns `None` if any segment is missing, out of range, or the value
/// at that point is a scalar with nothing to index into.
fn lookup_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = value;
    for part in path.split('.') {
        cur = match cur {
            serde_json::Value::Object(_) => cur.get(part)?,
            serde_json::Value::Array(arr) => arr.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn trim_range(bytes: &[u8], mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    (start, end)
}
