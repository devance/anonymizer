mod blobs;
#[cfg(debug_assertions)]
mod e2e;
mod db;
mod error;
mod files;
mod localhttp;
mod log;
mod models;
mod paths;
mod session;
mod sidecars;
mod system;
mod vault;

use std::sync::{Arc, Mutex};

use tauri::Manager;

pub struct AppState {
    pub paths: paths::Paths,
    pub session: Mutex<Option<session::Session>>,
    pub sidecars: sidecars::Sidecars,
    pub downloads: models::Downloads,
    pub streams: Arc<localhttp::Streams>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::init();
    tauri::Builder::default()
        // One process per database.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = paths::Paths::new(app.handle())?;
            let si = system::system_info();
            log::info(
                "app",
                &format!("started {} {} on {} {} {}, {}, {} GB RAM; data in {}", app.package_info().name, app.package_info().version, si.os, si.os_version, si.arch, si.cpu, si.ram_gb, paths.data.display()),
            );
            app.manage(AppState {
                paths,
                session: Mutex::new(None),
                sidecars: sidecars::Sidecars::default(),
                downloads: models::Downloads::default(),
                streams: Arc::new(localhttp::Streams::default()),
            });
            // The config's window colour is the light theme's; match a dark system
            // before the page paints, so dark mode opens without a light flash.
            if let Some(w) = app.get_webview_window("main") {
                if w.theme().ok() == Some(tauri::Theme::Dark) {
                    let _ = w.set_background_color(Some(tauri::window::Color(0x07, 0x0d, 0x3a, 0xff)));
                }
            }
            #[cfg(debug_assertions)]
            e2e::install(app)?;
            // Start the engine now so the first document doesn't wait for it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let _ = state.sidecars.engine(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::app_status,
            session::vault_create,
            session::vault_unlock,
            session::vault_auto_unlock,
            session::vault_lock,
            session::vault_change_password,
            session::vault_set_auto_unlock,
            session::vault_reset,
            session::db_all,
            session::db_run,
            session::db_batch,
            session::blob_put,
            session::blob_get,
            session::blob_delete,
            localhttp::local_http,
            localhttp::local_http_stream,
            localhttp::local_http_cancel,
            sidecars::sidecar_status,
            models::model_catalog,
            models::model_download,
            models::model_cancel,
            models::model_delete,
            models::model_import,
            models::llama_start,
            models::llama_stop,
            files::save_blob_as,
            files::reveal_data_dir,
            files::open_notices,
            log::log_write,
            log::log_heartbeat,
            log::reveal_logs,
            system::system_info,
            #[cfg(debug_assertions)]
            e2e::e2e_report,
            #[cfg(debug_assertions)]
            e2e::e2e_fixture,
            #[cfg(debug_assertions)]
            e2e::e2e_env,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                log::info("app", "quit");
                app.state::<AppState>().sidecars.kill_all()
            }
            // macOS: closing the window hides it; the app keeps running until Quit.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } => {
                if let Some(w) = app.get_webview_window(&label) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            _ => {}
        });
}
