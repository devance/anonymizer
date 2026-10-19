//! Debug builds only: `ANON_E2E=script.js` runs a script in the page once it
//! has loaded, and the script reports back through `e2e_report`, printed as
//! `E2E <line>` on stdout. "DONE" or "FAIL …" quits the app with 0 or 1.
//! Used with ANON_DATA_DIR so test runs never touch real data.

use tauri::{App, Manager};

pub fn install(app: &mut App) -> tauri::Result<()> {
    let Some(path) = std::env::var_os("ANON_E2E") else { return Ok(()) };
    let script = std::fs::read_to_string(&path)?;
    let window = app.get_webview_window("main").expect("main window");
    std::thread::spawn(move || {
        // Give the page time to boot; the script waits for its own conditions after that.
        std::thread::sleep(std::time::Duration::from_secs(3));
        let wrapped = format!(
            "(async () => {{ const report = (line) => window.__TAURI_INTERNALS__.invoke('e2e_report', {{ line: String(line) }}); try {{ {script}\n }} catch (e) {{ await report('FAIL ' + e + (e && e.stack ? ' @ ' + e.stack : '')); }} }})();"
        );
        let _ = window.eval(&wrapped);
    });
    Ok(())
}

/// An `E2E_*` environment variable, for scripts that take options.
#[tauri::command]
pub fn e2e_env(name: String) -> Option<String> {
    name.starts_with("E2E_").then(|| std::env::var(&name).ok()).flatten()
}

/// A file from the repo's fixtures/ folder, for scripts that upload documents.
#[tauri::command]
pub fn e2e_fixture(name: String) -> Result<tauri::ipc::Response, String> {
    if name.contains("..") || name.starts_with('/') {
        return Err("bad name".into());
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name);
    std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn e2e_report(app: tauri::AppHandle, line: String) {
    println!("E2E {line}");
    if line == "DONE" {
        app.exit(0);
    } else if line.starts_with("FAIL") {
        app.exit(1);
    }
}
