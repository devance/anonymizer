use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub ram_gb: u32,
    pub os: String,
    pub os_version: String,
    pub arch: &'static str,
    pub cpu: String,
}

/// What onboarding needs to suggest a model size, and what diagnostics copy.
#[tauri::command]
pub fn system_info() -> SystemInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    SystemInfo {
        ram_gb: ((sys.total_memory() as f64) / 1_073_741_824.0).round() as u32,
        os: std::env::consts::OS.to_string(),
        os_version: sysinfo::System::os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH,
        cpu: sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
    }
}
