use crate::dataset::{Dataset, DuplicateGroup, LoadSummary, RowKeys, RowPreview, SearchResult};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Shared app state. `op_generation` is bumped at the start of every
/// load/search — any long-running operation still in flight checks this
/// periodically and abandons itself if it's no longer the newest one, so
/// rapid typing or opening a new file mid-scan doesn't pile up wasted CPU
/// work fighting the newer request.
#[derive(Default)]
pub struct AppState {
    pub dataset: Mutex<Option<Dataset>>,
    pub op_generation: AtomicU64,
}

#[tauri::command]
pub async fn load_file(path: String, app: AppHandle) -> Result<LoadSummary, String> {
    let state = app.state::<AppState>();
    let my_gen = state.op_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let app_for_progress = app.clone();
    let app_for_cancel = app.clone();
    let path_owned = path.clone();

    let loaded = tauri::async_runtime::spawn_blocking(move || {
        let on_progress = move |pct: u8| {
            let _ = app_for_progress.emit("index-progress", pct);
        };
        let cancelled = move || {
            app_for_cancel.state::<AppState>().op_generation.load(Ordering::SeqCst) != my_gen
        };
        Dataset::load(&path_owned, &on_progress, &cancelled)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to open file: {e}"))?;

    let Some(dataset) = loaded else {
        return Err("SUPERSEDED".to_string()); // a newer load started; this one was abandoned
    };

    // Only commit if we're still the latest request (belt-and-suspenders;
    // the cancellation check above should already guarantee this).
    if state.op_generation.load(Ordering::SeqCst) != my_gen {
        return Err("SUPERSEDED".to_string());
    }

    let summary = dataset.summary();
    *state.dataset.lock().unwrap() = Some(dataset);
    Ok(summary)
}

#[tauri::command]
pub async fn get_rows(offset: usize, limit: usize, state: State<'_, AppState>) -> Result<Vec<RowPreview>, String> {
    // Cheap (only touches already-cached rows worth of bytes) — fine to
    // run inline without spawn_blocking.
    let guard = state.dataset.lock().unwrap();
    let ds = guard.as_ref().ok_or("No file loaded")?;
    Ok(ds.get_row_previews(offset, limit.min(500)))
}

#[tauri::command]
pub async fn get_row(index: usize, state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.dataset.lock().unwrap();
    let ds = guard.as_ref().ok_or("No file loaded")?;
    ds.get_row_pretty(index)
        .ok_or_else(|| "Row index out of range".to_string())?
}

#[tauri::command]
pub async fn get_row_keys(index: usize, state: State<'_, AppState>) -> Result<RowKeys, String> {
    let guard = state.dataset.lock().unwrap();
    let ds = guard.as_ref().ok_or("No file loaded")?;
    ds.row_key_paths(index, 4)
        .ok_or_else(|| "Row index out of range".to_string())
}

#[tauri::command]
pub async fn search_rows(query: String, case_sensitive: bool, app: AppHandle) -> Result<SearchResult, String> {
    let state = app.state::<AppState>();
    let my_gen = state.op_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app_for_cancel = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_cancel.state::<AppState>();
        let guard = state.dataset.lock().unwrap();
        let ds = guard.as_ref().ok_or_else(|| "No file loaded".to_string())?;
        let cancelled = || state.op_generation.load(Ordering::SeqCst) != my_gen;
        Ok::<_, String>(ds.search(&query, case_sensitive, 5000, &cancelled))
    })
    .await
    .map_err(|e| e.to_string())??;

    result.ok_or_else(|| "SUPERSEDED".to_string())
}

#[tauri::command]
pub async fn find_duplicates(keys: Option<Vec<String>>, app: AppHandle) -> Result<Vec<DuplicateGroup>, String> {
    let state = app.state::<AppState>();
    let my_gen = state.op_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app_for_cancel = app.clone();

    // Empty strings (e.g. leftover commas from "a,,b") aren't meaningful
    // keys, and an all-empty list should behave like "no keys" (full-row
    // comparison) rather than matching on nothing.
    let keys = keys.map(|ks| {
        ks.into_iter()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect::<Vec<_>>()
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_cancel.state::<AppState>();
        let guard = state.dataset.lock().unwrap();
        let ds = guard.as_ref().ok_or_else(|| "No file loaded".to_string())?;
        let cancelled = || state.op_generation.load(Ordering::SeqCst) != my_gen;
        Ok::<_, String>(match keys {
            Some(ks) if !ks.is_empty() => ds.find_duplicates_by_keys(&ks, &cancelled),
            _ => ds.find_duplicates(&cancelled),
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    result.ok_or_else(|| "SUPERSEDED".to_string())
}
