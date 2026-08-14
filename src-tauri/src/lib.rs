mod dataset;
mod commands;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init()) // for the native "open file" picker
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_file,
            commands::get_rows,
            commands::get_row,
            commands::get_row_keys,
            commands::search_rows,
            commands::find_duplicates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
