mod categorize;
mod commands;
mod error;
mod import;
mod models;
mod reconcile;
mod storage;

use tauri::Manager;

pub use models::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir().map_err(|error| {
                Box::<dyn std::error::Error>::from(format!(
                    "App-Datenordner konnte nicht bestimmt werden: {error}"
                ))
            })?;
            app.manage(commands::BackendState::new(storage::StateStore::new(
                app_data_directory,
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::preview_import,
            commands::commit_import,
            commands::categorize_transaction,
            commands::update_transaction_eur,
            commands::resolve_match,
            commands::upsert_import_profile,
            commands::upsert_rule,
            commands::delete_rule,
            commands::update_settings,
            commands::restore_backup,
        ])
        .run(tauri::generate_context!())
        .expect("Kontura konnte nicht gestartet werden");
}
